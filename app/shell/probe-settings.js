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
//   cache:lines       Housekeeping's cache picker: one line per cache (AppOps.CacheCategories) with its words, a themed tick
//                     and the size of exactly its folder on disk (the shader cache's absent folder reads "Empty"); the
//                     thumbnails ticked by default, nothing else; /cache/size agrees with the disk
//   cache:disabled    "Clear selected" is off with nothing ticked or only empty caches ticked, on otherwise (ticks by click)
//   cache:clear:<m>   a clear deletes exactly the ticked caches' files (the unticked ones, logs, history-*, src and we-ref
//                     stay), each cleared size eases down to "Empty" — motion on it counts down through in-between sizes and
//                     "Empty" rolls in; off / prefers-reduced-motion it only cross-fades — the button then turns off and
//                     "Freed N" appears; pictures settings-cache-mid-*.png, settings-cache-done-*.png
//   cache:look        a line's hover glow (and none under no-glow), the size and "Freed" in theme colours, bg-live: the
//                     lines add no fill of their own over the section card; pictures settings-cache-*.png
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

// the cache fixtures: in the stack's own HOME (the backend sizes and clears ~/.cache/liascape/<dir>; the stack's
// XDG_CACHE_HOME is ~/.cache, so the player's caches sit there too). No lwe-shaders: its line must read "Empty".
const CACHE = path.join(E.HOME, ".cache", "liascape");
const CACHE_DIRS = { thumbs: "workshop_previews", "we-thumbs": "we_thumbs", clips: "video_clips", "scene-loudness": "scene-loudness", "media-art": "media-art", shaders: "lwe-shaders", logs: "" };
const CACHE_LABEL = { thumbs: "Card stills and GIF previews", "we-thumbs": "Workshop folder thumbnails", clips: "Video preview clips",
  "scene-loudness": "Scene sound measurements", "media-art": "Album art", shaders: "Scene shader cache", logs: "Logs" };
const FIX = [["thumbs", "probe-still.jpg", 16 << 20], ["thumbs", "probe-anim.gif", 8 << 20], ["we-thumbs", "probe-we.jpg", 3 << 20],
  ["clips", "probe-clip.mp4", 12 << 20], ["scene-loudness", "00000000000000aa.json", 2 << 20], ["media-art", "00000000000000cc", 5 << 20],
  ["logs", "probe.log", 1 << 20], ["logs", "probe.log.1", 1 << 20]];
// beside the caches: never cleared
const BYSTANDERS = ["probe-bystander.txt", "history-probe/h.json", "src/probe.c", "we-ref/probe.txt"];
function writeFixtures() {
  for (const [id, n, size] of FIX) { const d = path.join(CACHE, CACHE_DIRS[id]); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, n), Buffer.alloc(size, 7)); }
  for (const f of BYSTANDERS) { fs.mkdirSync(path.dirname(path.join(CACHE, f)), { recursive: true }); fs.writeFileSync(path.join(CACHE, f), "keep"); }
}
// what a clear of `id` would free now: the regular files directly in its folder, no writer's temporaries (AppOps.CacheFiles)
const BUSY = /\.(tmp\d*|part)$|\.tmp\.jpg$|\.src\.gif$/;
// the logs sit in the cache's root: only `*.log` / `*.log.<n>` count (AppOps IsLog)
const LOG_RE = /\.log(\.\d+)?$/;
const dirBytes = (id) => { const d = path.join(CACHE, CACHE_DIRS[id]); try { return fs.readdirSync(d, { withFileTypes: true }).filter((x) => x.isFile() && !BUSY.test(x.name) && (id !== "logs" || LOG_RE.test(x.name))).reduce((s, x) => s + fs.statSync(path.join(d, x.name)).size, 0); } catch { return 0; } };
// Settings.tsx fmtBytes / sizeText
const fmtBytes = (b) => b >= 2 ** 30 ? `${(b / 2 ** 30).toFixed(1)} GB` : b >= 2 ** 20 ? `${Math.round(b / 2 ** 20)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;
const sizeText = (b) => (b > 0 ? fmtBytes(b) : "Empty");
const LINE = (id) => `.settings [data-cache-line="${id}"]`;
// the words a line's size shows (the face not marked off), as the page reads it
const shownSize = (id) => js(`const f = document.querySelector('[data-cache-size="${id}"] > :not([data-off])'); return f ? f.textContent : null`);
// tick the lines `ids` and untick the rest, by clicking the lines' names (the whole line is the label)
async function setTicks(ids) {
  for (const id of Object.keys(CACHE_DIRS)) {
    const st = await js(`const l = document.querySelector(${J(LINE(id))}); if (!l) return null; const c = l.querySelector("input[type=checkbox]");
      if (c.checked === ${J(ids)}.includes(${J(id)})) return "ok"; return await window.__x.show(l.querySelector(".slabel-row"))`);
    if (st == null) throw new Error(`no line ${id}`);
    if (st !== "ok") { await clickAt(st.x, st.y); await sleep(120); }
  }
  const got = await js(`return [...document.querySelectorAll(".settings [data-cache-line] input:checked")].map((c) => c.closest("[data-cache-line]").dataset.cacheLine)`);
  if (J([...got].sort()) !== J([...ids].sort())) throw new Error(`ticked ${J(got)}, want ${J(ids)}`);
}
// per frame for `ms`: each line's two size faces (opacity, vertical offset, words) and the "Freed" note's opacity
const SIZE_SAMPLE = (ms) => `(() => new Promise((res) => { const out = []; const t0 = performance.now();
  const f = () => { const t = Math.round(performance.now() - t0), row = { t, lines: {} };
    for (const e of document.querySelectorAll("[data-cache-size]")) row.lines[e.dataset.cacheSize] = [...e.children].map((x) => { const cs = getComputedStyle(x);
      return { o: +(+cs.opacity).toFixed(3), ty: +new DOMMatrix(cs.transform).f.toFixed(2), tx: x.textContent, on: !x.hasAttribute("data-off") }; });
    const n = document.querySelector("[data-cache-freed]"); row.freed = n ? +(+getComputedStyle(n).opacity).toFixed(3) : null;
    out.push(row); if (t < ${ms}) requestAnimationFrame(f); else res(out); };
  requestAnimationFrame(f); }))()`;

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

    await cell("cache:lines — one line per cache: its words, a themed tick, its folder's size; the thumbnails ticked", async () => {
      const v = [];
      writeFixtures();
      await setSettings({ SettingsLevel: "basic", Morphs: true }); await load();
      if (!(await js(`return !!document.querySelector("[data-cache-pick]")`))) return ["no cache picker ([data-cache-pick]) in Housekeeping"];
      await js(`await window.__x.show(document.querySelector("[data-cache-pick]")); return true`);
      await sleep(500);
      const lines = await js(`return [...document.querySelectorAll(".settings [data-cache-line]")].map((l) => { const c = l.querySelector("input[type=checkbox]"), cs = c && getComputedStyle(c);
        return { id: l.dataset.cacheLine, label: l.querySelector(".slabel-row")?.textContent.trim(), hint: l.querySelector(".shint")?.textContent ?? "", tag: l.tagName,
          box: !!c, themed: cs ? cs.appearance === "none" && cs.width === "18px" : false, checked: c?.checked }; })`);
      const ids = Object.keys(CACHE_DIRS);
      if (J(lines.map((l) => l.id)) !== J(ids)) v.push(`the lines are ${J(lines.map((l) => l.id))}, want ${J(ids)}`);
      for (const l of lines) {
        if (l.label !== CACHE_LABEL[l.id]) v.push(`${l.id}: labelled ${J(l.label)}, want ${J(CACHE_LABEL[l.id])}`);
        if (l.tag !== "LABEL") v.push(`${l.id}: the line isn't a <label> (a click on its words must tick it)`);
        if (!l.box || !l.themed) v.push(`${l.id}: no themed checkbox (${J(l)})`);
        if (l.checked !== ["thumbs", "we-thumbs"].includes(l.id)) v.push(`${l.id}: ${l.checked ? "ticked" : "unticked"} by default (only the thumbnails are)`);
        if (!l.hint) v.push(`${l.id}: no words on what clearing it costs`);
      }
      const sl = lines.find((l) => l.id === "scene-loudness");
      if (sl && !/measured again/.test(sl.hint)) v.push(`scene-loudness: its words don't say a clear means measuring again: ${J(sl.hint)}`);
      const api = (await http("GET", "/cache/size")).json;
      for (const id of ids) {
        const want = dirBytes(id), shown = await shownSize(id);
        // the stack's own logs grow while the cell runs: the logs line only has to read a size, and /cache/size list it
        if (id === "logs") { if (!/^(\d+(\.\d)? (KB|MB|GB)|Empty)$/.test(shown ?? "")) v.push(`logs: the size reads ${J(shown)}`); if (!api?.categories?.some((c) => c.id === "logs")) v.push("/cache/size has no logs"); continue; }
        if (shown !== sizeText(want)) v.push(`${id}: the size reads ${J(shown)}, want ${J(sizeText(want))} (${CACHE_DIRS[id]})`);
        const a = api?.categories?.find((c) => c.id === id);
        if (a?.bytes !== want) v.push(`/cache/size ${id}: ${J(a)}, want bytes ${want}`);
      }
      if (fs.existsSync(path.join(CACHE, "lwe-shaders"))) v.push("the stack made lwe-shaders — the \"Empty\" line proved nothing");
      const rect = await js(`const b = document.querySelector("[data-cache-pick]").getBoundingClientRect(); return { x: Math.round(b.x) - 10, y: Math.round(b.y) - 8, width: Math.round(b.width) + 20, height: Math.round(b.height) + 16 }`);
      await shot("cache-lines", rect);
      return v;
    });

    await cell("cache:disabled — \"Clear selected\" is off with nothing ticked or only empty caches ticked", async () => {
      const v = [];
      writeFixtures();
      await load();
      const dis = () => js(`return document.querySelector("[data-cache-clear]")?.disabled ?? null`);
      if (await dis() !== false) v.push(`the default ticks (non-empty thumbnails): disabled is ${await dis()}, want false`);
      await setTicks([]);
      if (await dis() !== true) v.push(`nothing ticked: disabled is ${await dis()}, want true`);
      await setTicks(["shaders"]);
      if (dirBytes("shaders") !== 0) v.push("the shader cache isn't empty — proved nothing");
      if (await dis() !== true) v.push(`only the empty shader cache ticked: disabled is ${await dis()}, want true`);
      await setTicks(["shaders", "media-art"]);
      if (await dis() !== false) v.push(`an empty and a full cache ticked: disabled is ${await dis()}, want false`);
      return v;
    });

    for (const mode of ["on", "off", "reduced"]) {
      await cell(`cache:clear:${mode} — only the ticked caches go; their sizes ease to "Empty"; the button turns off`, async () => {
        const v = [];
        await setSettings({ Morphs: mode !== "off" }); await reducedMotion(mode === "reduced");
        try {
          writeFixtures();
          await load();
          const noMotion = await js(`return document.documentElement.classList.contains("no-motion")`);
          if (noMotion !== (mode !== "on")) return [`:root.no-motion is ${noMotion} under motion ${mode} — proved nothing`];
          const pick = ["thumbs", "clips", "media-art"], keep = ["we-thumbs", "scene-loudness", "logs"];
          await setTicks(pick);
          const before = Object.fromEntries(Object.keys(CACHE_DIRS).map((id) => [id, dirBytes(id)]));
          for (const id of pick) if (!before[id]) return [`${id} holds nothing before the clear — proved nothing`];
          const p = await js(`return await window.__x.show(document.querySelector("[data-cache-clear]"))`);
          await sleep(300);
          const rect = await js(`const b = document.querySelector("[data-cache-pick]").getBoundingClientRect(); return { x: Math.round(b.x) - 10, y: Math.round(b.y) - 8, width: Math.round(b.width) + 20, height: Math.round(b.height) + 16 }`);
          const samp = js(`return await ${SIZE_SAMPLE(1700)}`);
          await sleep(60); await clickAt(p.x, p.y);
          await sleep(mode === "on" ? 300 : 90); await shot(`cache-mid-${mode}`, rect);
          const fr = await samp;
          // the files
          for (const [id, n] of FIX) {
            const f = path.join(CACHE, CACHE_DIRS[id], n), there = fs.existsSync(f) && (id !== "logs" || fs.statSync(f).size > 0); // a cleared current log stays, emptied
            if (pick.includes(id) && there) v.push(`${CACHE_DIRS[id]}/${n} survived the clear`);
            if (keep.includes(id) && !there) v.push(`${CACHE_DIRS[id]}/${n} was deleted though ${id} wasn't ticked`);
          }
          for (const f of BYSTANDERS) if (!fs.existsSync(path.join(CACHE, f))) v.push(`${f} (beside the caches) was deleted`);
          // the sizes, per frame
          for (const id of pick) {
            const seen = fr.map((f) => f.lines[id]).filter(Boolean);
            const shownTx = seen.map((faces) => faces.filter((x) => x.o > 0.05).map((x) => x.tx));
            const start = sizeText(before[id]), end = sizeText(dirBytes(id));
            const last = seen[seen.length - 1]?.find((x) => x.on);
            if (last?.tx !== end || !(last.o > 0.95)) v.push(`${id}: ends reading ${J(last)}, want ${J(end)} fully shown`);
            const between = [...new Set(shownTx.flat())].filter((t) => t !== start && t !== end);
            if (mode === "on") {
              if (between.length < 3) v.push(`${id}: motion on, the size didn't count down (in-between sizes ${J(between)})`);
              const inn = seen.filter((faces) => faces.some((x) => x.tx === end && x.o > 0.05 && x.o < 0.95 && Math.abs(x.ty) > 0.3)).length;
              if (end === "Empty" && inn < 2) v.push(`${id}: motion on, "Empty" didn't roll in (${inn} frames mid-roll)`);
            } else {
              if (between.length) v.push(`${id}: motion ${mode}, the size counted (${J(between.slice(0, 5))}) — want a cross-fade only`);
              const moved = seen.filter((faces) => faces.some((x) => Math.abs(x.ty) > 0.01 && x.o > 0.02));
              if (moved.length) v.push(`${id}: motion ${mode}, the words moved in ${moved.length} frames`);
              const mids = seen.filter((faces) => faces.some((x) => x.o > 0.05 && x.o < 0.95)).length;
              if (!mids) v.push(`${id}: motion ${mode}, the new size popped in — no in-between opacity frame`);
              const k0 = seen.findIndex((faces) => faces.some((x) => x.tx === end && x.o > 0.05)), k1 = seen.findIndex((faces) => faces.some((x) => x.tx === end && x.o >= 0.95));
              if (k0 >= 0 && k1 >= 0 && fr[k1].t - fr[k0].t > 300) v.push(`${id}: motion ${mode}, the fade took ${fr[k1].t - fr[k0].t} ms (want ≈ 120)`);
            }
            // a face keeps its words while it fades out: only the shown one may count
            for (const i of [0, 1]) {
              const fading = seen.filter((faces) => faces[i] && !faces[i].on && faces[i].o > 0.05).map((faces) => faces[i].tx);
              if (new Set(fading).size > 1) v.push(`${id}: a leaving face changed its words while it faded (${J([...new Set(fading)])})`);
            }
          }
          for (const id of keep) {
            const texts = new Set(fr.map((f) => f.lines[id]?.find((x) => x.on)?.tx));
            if (texts.size !== 1 || !texts.has(sizeText(before[id]))) v.push(`${id} (unticked): its size changed (${J([...texts])})`);
          }
          const after = await js(`return { dis: document.querySelector("[data-cache-clear]").disabled, freed: document.querySelector("[data-cache-freed]")?.textContent,
            fo: +getComputedStyle(document.querySelector("[data-cache-freed]")).opacity }`);
          const freed = pick.reduce((n, id) => n + before[id] - dirBytes(id), 0);
          if (after.dis !== true) v.push("\"Clear selected\" stays on with every ticked cache empty");
          if (after.freed !== `Freed ${fmtBytes(freed)}` || !(after.fo > 0.95)) v.push(`the note reads ${J(after.freed)} (opacity ${after.fo}), want ${J(`Freed ${fmtBytes(freed)}`)}`);
          const fo = fr.map((f) => f.freed).filter((o) => o != null);
          if (!fo.some((o) => o > 0.05 && o < 0.95)) v.push(`"Freed" popped in — no in-between opacity frame (${J([...new Set(fo)].slice(0, 8))})`);
          await shot(`cache-done-${mode}`, rect);
          return v;
        } finally { await reducedMotion(false); }
      });
    }
    await setSettings({ Morphs: true });

    await cell("cache:look — hover glow (none under no-glow), theme colours, bg-live adds no fill; pictures", async () => {
      const v = [];
      writeFixtures();
      await load();
      const C = (expr) => js(`const p = document.createElement("i"); p.style.color = ${J(expr)}; document.body.append(p); const c = getComputedStyle(p).color; p.remove(); return c`);
      const lit = (sh) => !!sh && sh !== "none" && sh.split(/,(?![^(]*\))/).some((part) => {
        const m = /rgba?\(([^)]*)\)/.exec(part); if (!m) return false; const c = m[1].split(",").map(Number); return c.length < 4 || c[3] > 0; });
      const id = "thumbs";
      const p = await js(`return await window.__x.show(document.querySelector(${J(LINE(id))} + " .slabel-row"))`);
      const rect = await js(`const b = document.querySelector("[data-cache-pick]").getBoundingClientRect(); return { x: Math.round(b.x) - 10, y: Math.round(b.y) - 8, width: Math.round(b.width) + 20, height: Math.round(b.height) + 16 }`);
      const read = () => js(`const l = document.querySelector(${J(LINE(id))}), b = getComputedStyle(l, "::before"), c = getComputedStyle(l.querySelector("input"));
        return { bar: b.boxShadow, barO: +b.opacity, box: c.boxShadow, bg: getComputedStyle(l).backgroundColor, size: getComputedStyle(document.querySelector('[data-cache-size="${id}"]')).color }`);
      await mv(5, 5, 300);
      await shot("cache-rest", rect);
      const rest = await read();
      if (rest.size !== await C("var(--subtext)")) v.push(`the size is ${rest.size}, want --subtext ${await C("var(--subtext)")}`);
      await mv(p.x, p.y, 400);
      const hov = await read();
      if (!(hov.barO > 0.9) || !lit(hov.bar)) v.push(`hovered, the line's accent bar doesn't glow (${J(hov)})`);
      if (!lit(hov.box)) v.push(`hovered, its ticked box doesn't glow (${hov.box})`);
      await shot("cache-hover", rect);
      await js(`document.documentElement.classList.add("no-glow"); return true`); await sleep(300);
      const ng = await read();
      if (lit(ng.bar) || lit(ng.box)) v.push(`no-glow: still glowing (${J(ng)})`);
      await shot("cache-hover-noglow", rect);
      await js(`document.documentElement.classList.remove("no-glow"); document.documentElement.classList.add("bg-live"); return true`); await mv(5, 5, 300);
      const bl = await read();
      // rgb() / rgba() / color(srgb … / a): the alpha, 1 when none is given
      const alpha = (c) => +(/\/\s*([0-9.]+)\s*\)$/.exec(c)?.[1] ?? /rgba\([^)]*,\s*([0-9.]+)\)/.exec(c)?.[1] ?? (/^(rgb|color)\(/.test(c) ? 1 : 0));
      if (alpha(bl.bg) > 0.01) v.push(`bg-live: the line has a fill of its own (${bl.bg}); the section card carries the darkness`);
      const card = await js(`return getComputedStyle(document.querySelector("[data-cache-pick]").closest(".ssection")).backgroundColor`);
      if (!(alpha(card) > 0 && alpha(card) < 1)) v.push(`bg-live: the section card isn't a see-through dark fill (${card})`);
      await shot("cache-bglive", rect);
      await js(`document.documentElement.classList.remove("bg-live"); return true`);
      // "Freed" in --success
      await setTicks(["media-art"]);
      const q = await js(`return await window.__x.show(document.querySelector("[data-cache-clear]"))`);
      await clickAt(q.x, q.y);
      await waitFor(() => js(`return +getComputedStyle(document.querySelector("[data-cache-freed]")).opacity > 0.95`), 3000);
      const fc = await js(`return getComputedStyle(document.querySelector("[data-cache-freed]")).color`);
      if (fc !== await C("var(--success)")) v.push(`"Freed" is ${fc}, want --success ${await C("var(--success)")}`);
      await mv(5, 5, 900);
      await shot("cache-freed", rect);
      return v;
    });
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
