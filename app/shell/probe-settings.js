// Settings rows probe — `scripts/test-ui-matrix.sh --probe probe-settings.js` (the matrix's hermetic stack: private backend
// + headless liascape-player + this tree's UI; its HOME is the stack's, so the cache fixtures below never touch a real one).
//   rename:autoMute   Sound → the auto-mute switch is the row "Mute when other apps play audio" under the "Auto-mute" heading (no "Mute when other audio plays"), it saves autoMute
//   copy:feedback     Keyboard shortcuts' Copy turns into a green "Copied" and settles back to "Copy" (hooks/useCopied.ts, the
//                     sidebar pill's timing): the two faces roll (motion on) or only cross-fade (motion off, prefers-reduced-motion),
//                     the button keeps its width and the command beside it never moves
//   copy:commands     what lands on the clipboard: a shortcut's command, Autostart's, and (Expert) the whole "mpv command"
//                     and "linux-wallpaperengine command" blocks
//   preview:monitors  removing a scene monitor drops it from the linux-wallpaperengine command (the preview used to read
//                     the settings file before the debounced save landed, so it showed the old list)
//   hint:transition   the Transition style hint explains only the chosen style; Settings has no Pre-measure scenes row
//   playtime:maxFloor:<where>  the maximum play time is 0 (off) or at least the minimum, in Settings (global) and the
//                     playlist window (its own rotation): a total typed under the minimum is a draft (shown, never saved)
//                     and leaving the fields saves the minimum; 0 saves "off"; the minimum raised past the maximum moves the
//                     maximum up with it at once (on screen and saved), lowered it leaves it; with "Switch when video ends"
//                     off ("Switch every") a smaller maximum is left alone until advance-on-end turns on
//   playtime:maxSteps:<where>  the maximum's − button, ↓ key and wheel stop at the minimum (nothing focused, or the field focused);
//                     what the fields show is what is saved after every step; a step up from "off" lands on the minimum; the
//                     minimum's + carries a maximum sitting on it up
//   loudness:target  the Loudness target goes up to 0 LUFS (typed 0 saves, + at 0 disabled), anything above clamps to 0 and below
//                     -70 to -70
//   playtime:scenesFloor  "Switch scenes and pictures after" is never 0: an all-zero entry is a draft that leaving drops,
//                     a 0 saved through the API comes back as 1 s
//   copy:sidebarPill  the Library sidebar's Workshop ID pill, which shares the feedback (hooks/useCopied.ts), still flips and copies
//   copy:look         hover glow, no-glow, bg-live (a see-through fill), "Copied" in --success; pictures settings-copy-*.png
//   nudge:engine      "Full-live sync nudge" (Full-live at Expert) only while the legacy engine runs — the page is told
//                     "legacy" by a stubbed /player-engine; hidden, its value stays saved
//   bg:onePoll        the live background behind Settings (components/WallpaperBg.tsx) keeps one /current read open at a
//                     time while every answer is held 7 s, and reads again once the slow one answered
//   vram:stopShows    "Stopped scene shows" (Expert, liascape-player) sits right under the video memory cap and only while the
//                     cap is on: the shared Segmented switch, Last frame / Nothing, Last frame by default; a click on Nothing
//                     saves sceneVramStopShows; at Advanced it hides and the value stays
//   fonts:rows        "Use Windows fonts in scenes" (Advanced, liascape-player only) sits right under "Play scenes", a
//                     checkbox row on by default that saves useWindowsFonts; "Windows fonts folder" (Expert) follows it,
//                     a text field + Browse that saves windowsFontsFolder as typed, dimmed and disabled (never removed) while
//                     the toggle is off; both hints keep the Settings words; at Advanced the folder hides and keeps its value;
//                     pictures settings-fonts-*.png (on, off, hovered, no-glow, bg-live)
//   levels:rows       each row the Settings re-tier moved (and a neighbour that stayed) shows from exactly its level; the
//                     steamcmd route's setup rows never show where its radio doesn't
//   levels:noEmptySection:<engine>  at every level, under liascape-player and a stubbed legacy, no section heading shows
//                     without a row; Video and Keyboard shortcuts open at Basic with one row each; Playback hides at Basic on legacy;
//                     legacy: "Scene transition delay (ms)" only at Expert
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
//   mute:reset        the Volume row's reset unmutes and puts the level at 100 %; shown only while muted or off 100 %
//   mute:row:<level>  Sound has no "Mute wallpapers" checkbox row; the Volume row ends in the shared mute chip (button.side-mute,
//                     components/MuteButton.tsx) after the slider, 32 px, on the slider's centre line, at the row's control edge;
//                     a click saves noAudio and dims the slider, the hint ("muted") and "Audio normalization" but not the chip,
//                     a second click un-mutes
//   mute:motion:<m>   motion on: the new glyph pops through in-between sizes on a click (transform / opacity only); off and
//                     prefers-reduced-motion: it only swaps; nothing pops on load; pictures settings-mute-motion-*.png
//   mute:look         the chip's accent fill while sound plays (--accent / --accent-fg), see-through and --text while muted, hover
//                     glow (none under no-glow), bg-live; pictures settings-mute-look-*.png
// Exit 1 on any FAIL. LIASCAPE_ONLY = a regex over the cell names.
const { app, BrowserWindow, clipboard, session } = require("electron");
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
// how long a save may take to land: an atomic write + fsync, which on a busy disk (another process's heavy writes to the
// same btrfs) took 3–16 s for one POST /settings, the page's saves queued behind each other. A ceiling only: the
// waits end the moment the value is saved.
const SAVE_MS = 20000;
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
// `engine`: answer the page's /player-engine with this engine (the Settings view asks it when it mounts).
// Settings shows its rows before the store's settings and the engine's answer arrive (a row they hide is simply absent
// until then), so a load waits for both: the level on screen is the saved one, and the view's /player-engine answered.
// No fixed pause covers a loaded box (nudge:engine read "legacy, Full-live: no nudge row") and a stalled disk holds
// them for seconds, so the wait is long; it ends the moment both are in.
async function load({ engine } = {}) {
  await win.loadURL(withToken(U + "/"));
  for (let i = 0; i < 100 && !(await js(`return !!document.querySelector(".tab")`)); i++) await sleep(100);
  await js(HELPERS);
  await js(`await window.__x.tab("Library"); return true`);
  await js(`const of = window.fetch.bind(window); window.__engineRead = 0; window.__engineAsked = [];
    window.fetch = (u, o) => !String(u).includes("/player-engine") ? of(u, o)
      : (window.__engineAsked.push(Math.round(performance.now())), ${engine ? `Promise.resolve(new Response(${J(J({ engine, active: engine, available: true, binary: null, reason: null }))}, { headers: { "Content-Type": "application/json" } }))` : "of(u, o)"})
        .finally(() => { window.__engineRead++; }); return true`);
  const level = (await field("settingsLevel")) ?? "standard";
  const ready = await js(`await window.__x.tab("Settings");
    for (let i = 0; i < 300 && !(document.querySelector(".settings .srow") && window.__engineRead > 0
      && document.querySelector("[data-settings-level]")?.dataset.settingsLevel === ${J(level)}); i++) await window.__x.sleep(100);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return { rows: !!document.querySelector(".settings .srow"), engine: window.__engineRead > 0, level: document.querySelector("[data-settings-level]")?.dataset.settingsLevel,
      engineAskedAgo: window.__engineAsked.map((t) => Math.round(performance.now()) - t) }`);
  if (!ready.rows || !ready.engine || ready.level !== level) throw new Error(`Settings never got ready (${J(ready)}, saved level ${J(level)})`);
  await sleep(700);
}
const has = (label) => js(`return !!window.__x.row(${J(label)})`);

// per frame for at least `ms`: the copy-like control `sel` (its faces' opacity + vertical offset, its width / left, data-copied)
// and a neighbour `near` (its layout left, so a pressed button's squeeze isn't a move) — what the eye sees while the words
// change. It goes on until the control turned "Copied" and is back at rest for 8 frames (up to `cap`): on a loaded box the
// click lands late, and a fixed window can end mid-hold ("never settled back").
const SAMPLE = (sel, near, ms, cap = ms + 3000) => `(() => new Promise((res) => { const out = []; const t0 = performance.now(); let seenOn = false, rest = 0;
  const f = () => { const t = Math.round(performance.now() - t0), b = document.querySelector(${J(sel)}), n = ${near ? `document.querySelector(${J(near)})` : "null"};
    if (!b) out.push({ t, gone: true });
    else { const r = b.getBoundingClientRect();
      const row = { t, on: b.hasAttribute("data-copied"), w: +r.width.toFixed(2), x: +r.x.toFixed(2), nx: n ? n.offsetLeft : null,
        faces: [...b.querySelectorAll(".xfade > *")].map((x) => { const cs = getComputedStyle(x); return { o: +(+cs.opacity).toFixed(3), ty: +new DOMMatrix(cs.transform).f.toFixed(2), tf: cs.transform, tx: x.textContent }; }) };
      out.push(row); seenOn ||= row.on;
      rest = seenOn && !row.on && row.faces[0]?.o >= 0.95 && row.faces[1]?.o <= 0.05 && Math.abs(row.faces[0].ty) <= 0.3 ? rest + 1 : 0; }
    if (t < ${ms} || (t < ${cap} && rest < 8)) requestAnimationFrame(f); else res(out); };
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
// per frame for at least `ms`: each line's two size faces (opacity, vertical offset, words) and the "Freed" note's opacity.
// It goes on (up to `cap`) until the clear answered — "Freed" fully shown — and every face is at rest for 8 frames: on a
// loaded box the clear can answer late, and a cell that moves on judges files the backend is still deleting while the
// next cell's fresh fixtures fall to this clear ("holds nothing before the clear").
const SIZE_SAMPLE = (ms, cap = ms + SAVE_MS) => `(() => new Promise((res) => { const out = []; const t0 = performance.now(); let rest = 0;
  const f = () => { const t = Math.round(performance.now() - t0), row = { t, lines: {} };
    for (const e of document.querySelectorAll("[data-cache-size]")) row.lines[e.dataset.cacheSize] = [...e.children].map((x) => { const cs = getComputedStyle(x);
      return { o: +(+cs.opacity).toFixed(3), ty: +new DOMMatrix(cs.transform).f.toFixed(2), tx: x.textContent, on: !x.hasAttribute("data-off") }; });
    const n = document.querySelector("[data-cache-freed]"); row.freed = n ? +(+getComputedStyle(n).opacity).toFixed(3) : null;
    const still = Object.values(row.lines).every((faces) => faces.every((x) => (x.o <= 0.02 || x.o >= 0.98) && Math.abs(x.ty) <= 0.3));
    rest = row.freed >= 0.98 && still ? rest + 1 : 0;
    out.push(row); if (t < ${ms} || (t < ${cap} && rest < 8)) requestAnimationFrame(f); else res(out); };
  requestAnimationFrame(f); }))()`;

app.whenReady().then(async () => {
  // The Library cards' stills, GIF previews and clips are made on request into the very folders the cache cells fill and
  // clear (workshop_previews, video_clips): one made for a card the page just reloaded can land after a clear, and the
  // line's "Empty" no longer matches the disk. No cell here looks at a card's picture, so the page never asks for one.
  session.defaultSession.webRequest.onBeforeRequest({ urls: ["*://127.0.0.1/still*", "*://127.0.0.1/anim*", "*://127.0.0.1/clip*"] }, (d, cb) => cb({ cancel: true }));
  win = new BrowserWindow({ show: true, width: 1400, height: 900, webPreferences: { backgroundThrottling: false } });
  win.focus();
  try {
    await setSettings({ SettingsLevel: "standard", Morphs: true, Glows: true });
    await load().catch((e) => console.log(`(the first load: ${e.message})`)); // a warm-up: each cell loads its own page

    await cell("rename:autoMute — the row is \"Mute when other apps play audio\" and still switches autoMute", async () => {
      const v = [];
      await setSettings({ SettingsLevel: "basic", AutoMute: false }); await load();
      if (await has("Mute when other audio plays")) v.push('the old label "Mute when other audio plays" is still a row');
      const r = await js(`const r = window.__x.row("Mute when other apps play audio"); if (!r) return null;
        return { section: r.closest(".ssection")?.querySelector("h3")?.textContent.trim(), box: !!r.querySelector("input[type=checkbox]"), toggle: r.hasAttribute("data-row-toggle"),
          hint: r.querySelector(".shint")?.textContent ?? "" }`);
      if (!r) return [...v, 'no row labelled "Mute when other apps play audio" at Basic'];
      if (!r.box || !r.toggle) v.push(`the row isn't a whole-row checkbox (${J(r)})`);
      if (!/^Auto-mute$/i.test(r.section ?? "")) v.push(`it sits in section ${J(r.section)}, want Auto-mute`);
      const p = await js(`return await window.__x.show(window.__x.row("Mute when other apps play audio").querySelector(".slabel"))`);
      await clickAt(p.x, p.y);
      if (!(await waitFor(async () => (await field("autoMute")) === true, SAVE_MS))) v.push(`a click on the row didn't save autoMute (${await field("autoMute")})`);
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
        ["mpv command", '[data-copy="mpv command"]', blocks["mpv command"]],
        ["linux-wallpaperengine command", '[data-copy="linux-wallpaperengine command"]', blocks["linux-wallpaperengine command"]],
      ];
      for (const [what, sel, text] of want) {
        if (!text || text === "…") { v.push(`${what}: nothing to copy (${J(text)}) — proved nothing`); continue; }
        const p = await js(`return await window.__x.show(document.querySelector(${J(sel)}))`);
        if (!p) { v.push(`${what}: no Copy button (${sel})`); continue; }
        await clipboard.writeText("");
        await js(`window.__wrote.length = 0; return true`);
        await clickAt(p.x, p.y);
        await waitFor(async () => (await clipboard.readText()) !== "", 1500);
        const got = await clipboard.readText(), wrote = await js(`return window.__wrote.slice()`);
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

    await cell("preview:monitors — removing a scene monitor drops it from the linux-wallpaperengine command (it read the old file)", async () => {
      const v = [];
      await setSettings({ SettingsLevel: "expert", AllowScenes: true, SceneMonitors: [{ Name: "PRB-A", Fps: 15, IsPrimary: true }, { Name: "PRB-B", Fps: 15, IsPrimary: false }] });
      await load();
      const lwe = () => js(`return [...document.querySelectorAll(".settings .ssection")].find((s) => s.querySelector("h3")?.textContent.trim() === "linux-wallpaperengine command")?.querySelector("pre.mpv")?.textContent ?? null`);
      if (!(await waitFor(async () => /PRB-B/.test((await lwe()) ?? ""), 6000))) v.push(`before: the command doesn't list PRB-B (${J(await lwe())})`);
      const p = await js(`const b = [...document.querySelectorAll('[aria-label="Remove monitor"]')].pop(); return b ? await window.__x.show(b) : null`);
      if (!p) return [...v, "no Remove monitor button"];
      await clickAt(p.x, p.y);
      if (!(await waitFor(async () => { const s = (await lwe()) ?? ""; return /PRB-A/.test(s) && !/PRB-B/.test(s); }, SAVE_MS)))
        v.push(`after removing PRB-B the command still reads ${J(await lwe())}`);
      await setSettings({ SceneMonitors: [], AllowScenes: false, SettingsLevel: "standard" });
      return v;
    });

    await cell("hint:transition — the Transition style hint says what the chosen style does; no Pre-measure scenes row", async () => {
      const v = [];
      const want = { reveal: /Reveal: the old one holds its last frame/, frozen: /Frozen: both hold still/, "full-live": /Full-live: both keep playing/ };
      for (const [m, re] of Object.entries(want)) {
        await setSettings({ SettingsLevel: "expert", TransitionMethod: m }); await load();
        const h = await js(`return window.__x.row("Transition style")?.querySelector(".shint")?.textContent ?? null`);
        if (!re.test(h ?? "")) v.push(`${m}: the hint reads ${J(h)}`);
        for (const [o, ro] of Object.entries(want)) if (o !== m && ro.test(h ?? "")) v.push(`${m}: the hint also explains ${o}`);
      }
      await setSettings({ NormalizeAudio: true }); await load();
      if (await has("Pre-measure scenes")) v.push("a Pre-measure scenes row is still there (imports and syncs measure scenes by themselves)");
      await setSettings({ TransitionMethod: "reveal", NormalizeAudio: false, SettingsLevel: "standard" });
      return v;
    });

    // --- the rotation's h/m/s fields (components/PlayTimeInput.tsx): `grp` = the group's selector in the page
    const hmsOf = (grp) => js(`return [...(${grp})?.querySelectorAll("input") ?? []].map((x) => +x.value)`);
    // set field `i` (0 h, 1 m, 2 s) of a group as typing does, unfocused (a complete value commits at once); `blur` =
    // focus then leaves the group
    const setHms = (grp, i, v, blur = false) => js(`const g = ${grp}; const el = g.querySelectorAll("input")[${i}];
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, String(${v})); el.dispatchEvent(new Event("input", { bubbles: true }));
      await window.__x.sleep(120); ${blur ? 'el.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); await window.__x.sleep(120);' : ""} return true`);
    const blurHms = (grp) => js(`const el = (${grp}).querySelector("input"); el.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); await window.__x.sleep(150); return true`);
    const psOf = async () => (await http("GET", "/playlist/state")).json?.settings ?? {};
    for (const where of ["global", "playlist"]) {
      await cell(`playtime:maxFloor:${where} — the maximum is 0 or at least the minimum; a raised minimum carries it up`, async () => {
        const v = [];
        const G = where === "global";
        const MIN = G ? `window.__x.row("Minimum play time")?.querySelector(".hms")` : `document.querySelectorAll(".pl-modal .hms")[0]`;
        const MAX = G ? `window.__x.row("Maximum play time")?.querySelector(".hms")` : `document.querySelectorAll(".pl-modal .hms")[1]`;
        const EVERY = G ? `window.__x.row("Switch every")?.querySelector(".hms")` : MIN;
        const saved = async () => { if (G) { const st = (await http("GET", "/settings")).json ?? {}; return [st.globalSwitchWhenVideoEnds, st.globalIntervalSeconds, st.globalMaxPlaySeconds]; }
          const ps = await psOf(); return [ps.switchWhenVideoEnds, ps.intervalSeconds, ps.maxPlaySeconds]; };
        const settle = (want) => waitFor(async () => J(await saved()) === J(want), SAVE_MS);
        const advance = (on) => G ? js(`const c = window.__x.row("Switch when video ends")?.querySelector("input"); if (c.checked !== ${on}) c.click(); await window.__x.sleep(400); return true`)
          : js(`const c = [...document.querySelectorAll(".pl-modal label.ck")].find((l) => l.textContent.trim().startsWith("Switch when video ends"))?.querySelector("input"); if (c.checked !== ${on}) c.click(); await window.__x.sleep(400); return true`);
        const ps0 = (await http("GET", "/playlist/state")).json;
        const g0 = { GlobalSwitchWhenVideoEnds: await field("globalSwitchWhenVideoEnds"), GlobalIntervalSeconds: await field("globalIntervalSeconds"), GlobalMaxPlaySeconds: await field("globalMaxPlaySeconds") };
        try {
          if (G) await setSettings({ SettingsLevel: "standard", GlobalSwitchWhenVideoEnds: true, GlobalIntervalSeconds: 600, GlobalMaxPlaySeconds: 0 });
          else await http("POST", "/playlist/state", { settings: { overrideGlobalSettings: true, switchWhenVideoEnds: true, intervalSeconds: 600, maxPlaySeconds: 0 } });
          await load();
          if (!G) await js(`await window.__x.tab("Library"); document.querySelector('button[title="Playlist settings"]').click(); await window.__x.sleep(600); return true`);
          if (J(await hmsOf(MIN)) !== J([0, 10, 0]) || J(await hmsOf(MAX)) !== J([0, 0, 0])) return [`setup: minimum ${J(await hmsOf(MIN))} / maximum ${J(await hmsOf(MAX))}, want 0:10:00 / off — proved nothing`];
          // 5 min typed under the 10 min minimum: shown, not saved; leaving the fields saves the minimum
          await setHms(MAX, 1, 5); await sleep(600);
          if (J(await hmsOf(MAX)) !== J([0, 5, 0])) v.push(`typing 5 m into the maximum shows ${J(await hmsOf(MAX))}, want the draft [0,5,0]`);
          if (J(await saved()) !== J([true, 600, 0])) v.push(`a 5 min maximum under the 10 min minimum was saved: ${J(await saved())}`);
          await blurHms(MAX);
          if (!(await settle([true, 600, 600]))) v.push(`leaving the 5 min draft saved ${J(await saved())}, want the maximum raised to the minimum (600)`);
          if (J(await hmsOf(MAX)) !== J([0, 10, 0])) v.push(`after leaving, the maximum shows ${J(await hmsOf(MAX))}, want [0,10,0]`);
          // over the minimum: saved as typed; 0 = off is allowed
          await setHms(MAX, 1, 15);
          if (!(await settle([true, 600, 900]))) v.push(`a 15 min maximum saved ${J(await saved())}, want 900`);
          await setHms(MAX, 1, 0);
          if (!(await settle([true, 600, 0]))) v.push(`a 0 maximum (off) saved ${J(await saved())}, want 0`);
          if (!(await js(`return !!(${MAX})?.querySelector(".playtime-zero")`))) v.push("a 0 maximum doesn't say \"off\"");
          await setHms(MAX, 1, 15); await settle([true, 600, 900]);
          // the minimum raised past the maximum: the maximum follows at once, on screen and saved
          await setHms(MIN, 1, 20);
          const at = await hmsOf(MAX);
          if (J(at) !== J([0, 20, 0])) v.push(`the minimum raised to 20 m: the maximum shows ${J(at)} at once, want [0,20,0]`);
          if (!(await settle([true, 1200, 1200]))) v.push(`the minimum raised to 20 m saved ${J(await saved())}, want [true,1200,1200]`);
          // lowered again: the maximum stays where it was carried
          await setHms(MIN, 1, 5);
          if (!(await settle([true, 300, 1200]))) v.push(`the minimum lowered to 5 m saved ${J(await saved())}, want the maximum kept at 1200`);
          if (J(await hmsOf(MAX)) !== J([0, 20, 0])) v.push(`after lowering the minimum the maximum shows ${J(await hmsOf(MAX))}, want [0,20,0]`);
          // "Switch when video ends" off: the field is "Switch every" (no minimum), a longer one leaves the maximum alone…
          await advance(false);
          await setHms(EVERY, 1, 30);
          if (!(await settle([false, 1800, 1200]))) v.push(`advance-on-end off, "Switch every" 30 m saved ${J(await saved())}, want [false,1800,1200]`);
          // …until advance-on-end turns on and the 30 m becomes the minimum
          await advance(true);
          if (J(await hmsOf(MAX)) !== J([0, 30, 0])) v.push(`advance-on-end back on: the maximum shows ${J(await hmsOf(MAX))}, want [0,30,0] (the 30 m minimum)`);
          if (!(await settle([true, 1800, 1800]))) v.push(`advance-on-end back on saved ${J(await saved())}, want [true,1800,1800]`);
        } finally {
          if (G) await setSettings(g0);
          else { await js(`[...document.querySelectorAll(".pl-modal button")].find((b) => b.textContent.trim() === "Close")?.click(); return true`); await sleep(300);
            await http("POST", "/playlist/state", { settings: ps0?.settings ?? { overrideGlobalSettings: false, switchWhenVideoEnds: true, intervalSeconds: 0, maxPlaySeconds: 0 } }); }
        }
        return v;
      });
    }

    // the maximum's steppers, keys and wheel (and the minimum's) stop where the maximum would go under the minimum: what the fields
    // show is what is saved, a draft is only ever typed; a step up from "off" lands on the minimum
    for (const where of ["global", "playlist"]) {
      await cell(`playtime:maxSteps:${where} — the maximum's −, keys and wheel never go under the minimum; shown = saved`, async () => {
        const v = [];
        const G = where === "global";
        const MIN = G ? `window.__x.row("Minimum play time")?.querySelector(".hms")` : `document.querySelectorAll(".pl-modal .hms")[0]`;
        const MAX = G ? `window.__x.row("Maximum play time")?.querySelector(".hms")` : `document.querySelectorAll(".pl-modal .hms")[1]`;
        const saved = async () => { if (G) { const st = (await http("GET", "/settings")).json ?? {}; return [st.globalSwitchWhenVideoEnds, st.globalIntervalSeconds, st.globalMaxPlaySeconds]; }
          const ps = await psOf(); return [ps.switchWhenVideoEnds, ps.intervalSeconds, ps.maxPlaySeconds]; };
        const secs = (a) => a[0] * 3600 + a[1] * 60 + a[2];
        const ps0 = (await http("GET", "/playlist/state")).json;
        const g0 = { GlobalSwitchWhenVideoEnds: await field("globalSwitchWhenVideoEnds"), GlobalIntervalSeconds: await field("globalIntervalSeconds"), GlobalMaxPlaySeconds: await field("globalMaxPlaySeconds") };
        // what the fields show is what lands in the file, and the maximum is 0 or at least the minimum, after every step
        const agree = async (what) => {
          const shownMax = secs(await hmsOf(MAX)), shownMin = secs(await hmsOf(MIN));
          if (!(await waitFor(async () => { const [, mn, mx] = await saved(); return mn === shownMin && mx === shownMax; }, 4000)))
            v.push(`${what}: the fields show min ${shownMin} s / max ${shownMax} s, saved ${J(await saved())}`);
          if (shownMax !== 0 && shownMax < shownMin) v.push(`${what}: the maximum shows ${shownMax} s under the minimum ${shownMin} s`);
        };
        const btn = (grp, i, dir) => js(`const b = (${grp}).querySelectorAll(".num-step")[${i}].querySelector('[data-step="${dir}"]'); return await window.__x.show(b)`);
        const press = async (grp, i, dir, what) => { const p = await btn(grp, i, dir); await clickAt(p.x, p.y); await sleep(450); await agree(what); };
        try {
          if (G) await setSettings({ SettingsLevel: "standard", GlobalSwitchWhenVideoEnds: true, GlobalIntervalSeconds: 8, GlobalMaxPlaySeconds: 10 });
          else await http("POST", "/playlist/state", { settings: { overrideGlobalSettings: true, switchWhenVideoEnds: true, intervalSeconds: 8, maxPlaySeconds: 10 } });
          await load();
          if (!G) await js(`await window.__x.tab("Library"); document.querySelector('button[title="Playlist settings"]').click(); await window.__x.sleep(600); return true`);
          if (J(await hmsOf(MIN)) !== J([0, 0, 8]) || J(await hmsOf(MAX)) !== J([0, 0, 10])) return [`setup: minimum ${J(await hmsOf(MIN))} / maximum ${J(await hmsOf(MAX))}, want 0:00:08 / 0:00:10 — proved nothing`];
          // − on the maximum's seconds, nothing focused: 9, 8, then it stays at the minimum
          await press(MAX, 2, -1, "− 10 → 9");
          await press(MAX, 2, -1, "− 9 → 8");
          for (let i = 0; i < 2; i++) await press(MAX, 2, -1, "− at the minimum");
          if (J(await hmsOf(MAX)) !== J([0, 0, 8])) v.push(`− past the minimum: the maximum shows ${J(await hmsOf(MAX))}, want it stopped at [0,0,8]`);
          // the keys (focus in the seconds field): up moves it, down stops at the minimum
          const f = await js(`return await window.__x.show((${MAX}).querySelectorAll("input")[2])`);
          await clickAt(f.x, f.y); await sleep(200);
          const key = async (k) => { send({ type: "keyDown", keyCode: k }); send({ type: "keyUp", keyCode: k }); await sleep(450); };
          await key("Up"); await key("Up"); await agree("keys up");
          const up = secs(await hmsOf(MAX));
          if (up !== 10) v.push(`two ↑ from the minimum: the maximum shows ${up} s, want 10 (vacuous: the keys moved nothing)`);
          for (let i = 0; i < 4; i++) { await key("Down"); await agree(`key ↓ #${i + 1}`); }
          if (J(await hmsOf(MAX)) !== J([0, 0, 8])) v.push(`↓ past the minimum: the maximum shows ${J(await hmsOf(MAX))}, want it stopped at [0,0,8]`);
          // the wheel over the focused field, both ways
          const wheel = async (dy) => { send({ type: "mouseWheel", x: Math.round(f.x), y: Math.round(f.y), deltaX: 0, deltaY: dy, canScroll: true }); await sleep(450); };
          await wheel(-120);
          const upDy = secs(await hmsOf(MAX)) > 8 ? -120 : 120; // which way is "up" depends on the platform's wheel sign
          if (upDy === 120) { await wheel(120); if (secs(await hmsOf(MAX)) <= 8) v.push("the wheel moved the maximum neither way — proved nothing"); }
          await agree("wheel up");
          for (const dy of [upDy, -upDy, -upDy, -upDy, -upDy, upDy, -upDy, -upDy, -upDy, -upDy, -upDy]) { await wheel(dy); await agree(`wheel ${dy === upDy ? "up" : "down"}`); }
          if (J(await hmsOf(MAX)) !== J([0, 0, 8])) v.push(`after the wheel's notches down the maximum shows ${J(await hmsOf(MAX))}, want it stopped at [0,0,8]`);
          // a step up from "off" lands on the minimum, not 1 s
          await setHms(MAX, 2, 0); await sleep(600);
          if (J(await saved()) !== J([true, 8, 0])) v.push(`typing 0 s saved ${J(await saved())}, want the maximum off (0)`);
          await press(MAX, 2, 1, "+ from off");
          if (J(await hmsOf(MAX)) !== J([0, 0, 8])) v.push(`+ from off: the maximum shows ${J(await hmsOf(MAX))}, want [0,0,8] (the minimum)`);
          // the minimum's own + carries a maximum at it up, on screen and saved
          await press(MIN, 2, 1, "minimum +");
          if (J(await hmsOf(MIN)) !== J([0, 0, 9]) || J(await hmsOf(MAX)) !== J([0, 0, 9])) v.push(`minimum + : minimum ${J(await hmsOf(MIN))} / maximum ${J(await hmsOf(MAX))}, want both [0,0,9]`);
        } finally {
          if (G) await setSettings(g0);
          else { await js(`[...document.querySelectorAll(".pl-modal button")].find((b) => b.textContent.trim() === "Close")?.click(); return true`); await sleep(300);
            await http("POST", "/playlist/state", { settings: ps0?.settings ?? { overrideGlobalSettings: false, switchWhenVideoEnds: true, intervalSeconds: 0, maxPlaySeconds: 0 } }); }
        }
        return v;
      });
    }

    await cell("loudness:target — the Loudness target reaches 0 LUFS: typed 0 saves, + at 0 is off, more than 0 and under -70 clamp", async () => {
      const v = [];
      const IN = `window.__x.row("Loudness target")?.querySelector("input")`;
      const typed = (n) => js(`const el = ${IN}; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, String(${n})); el.dispatchEvent(new Event("input", { bubbles: true })); await window.__x.sleep(150); return +el.value`);
      try {
        await setSettings({ SettingsLevel: "advanced", NormalizeAudio: true, NoAudio: false, NormalizeTargetLufs: -14 }); await load();
        if (!(await js(`return !!${IN}`))) return ["no Loudness target row with normalization on — proved nothing"];
        if ((await typed(0)) !== 0) v.push("typing 0 doesn't show 0");
        if (!(await waitFor(async () => (await field("normalizeTargetLufs")) === 0, SAVE_MS))) v.push(`0 saved as ${await field("normalizeTargetLufs")}`);
        const plus = await js(`return !!${IN}?.closest(".num-step")?.querySelector('[data-step="1"]')?.disabled`);
        if (!plus) v.push("at 0 the + button isn't disabled (nothing is louder than 0)");
        if ((await typed(5)) !== 0) v.push("typing 5 isn't clamped to 0");
        if ((await typed(-100)) !== -70) v.push("typing -100 isn't clamped to -70");
        if (!(await waitFor(async () => (await field("normalizeTargetLufs")) === -70, SAVE_MS))) v.push(`-100 saved as ${await field("normalizeTargetLufs")}, want -70`);
      } finally { await setSettings({ NormalizeAudio: false, NormalizeTargetLufs: -14 }); }
      return v;
    });

    await cell("playtime:scenesFloor — \"Switch scenes and pictures after\" is never 0 (a draft in the page, 1 s from the API)", async () => {
      const v = [];
      const AFTER = `window.__x.row("Switch scenes and pictures after")?.querySelector(".hms")`;
      const after = async () => (await http("GET", "/settings")).json?.globalSwitchScenesAfterSeconds;
      try {
        await setSettings({ SettingsLevel: "standard", GlobalSwitchWhenVideoEnds: true, GlobalSeparateSceneTiming: true, GlobalSwitchScenesAfterSeconds: 1800 }); await load();
        if (J(await hmsOf(AFTER)) !== J([0, 30, 0])) return [`setup: the row shows ${J(await hmsOf(AFTER))}, want [0,30,0] — proved nothing`];
        await setHms(AFTER, 1, 0); await sleep(600);
        if (J(await hmsOf(AFTER)) !== J([0, 0, 0])) v.push(`zeroing the minutes shows ${J(await hmsOf(AFTER))}, want the draft [0,0,0]`);
        if ((await after()) !== 1800) v.push(`an all-zero entry was saved: ${await after()}`);
        await blurHms(AFTER);
        if (J(await hmsOf(AFTER)) !== J([0, 30, 0])) v.push(`leaving the all-zero draft shows ${J(await hmsOf(AFTER))}, want the saved [0,30,0] back`);
        if ((await after()) !== 1800) v.push(`leaving the all-zero draft saved ${await after()}, want 1800 kept`);
        await setSettings({ GlobalSwitchScenesAfterSeconds: 0 });
        if ((await after()) !== 1) v.push(`the API's 0 saved as ${await after()}, want 1 (the floor)`);
        await load();
        if (J(await hmsOf(AFTER)) !== J([0, 0, 1])) v.push(`after the API's 0 the row shows ${J(await hmsOf(AFTER))}, want [0,0,1]`);
      } finally { await setSettings({ GlobalSwitchScenesAfterSeconds: 1800 }); }
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
      await clipboard.writeText("");
      await clickAt(p.x, p.y);
      const t0 = Date.now();
      if (!(await waitFor(() => js(`return document.querySelector(${J(SHOWN)})?.textContent.trim() === "Copied"`), 600, 30))) v.push(`the pill never read "Copied" (${await js(`return document.querySelector(${J(SHOWN)})?.textContent.trim()`)})`);
      if (!(await waitFor(() => js(`return document.querySelector(${J(SHOWN)})?.textContent.trim() === ${J(id)}`), 2500, 50))) v.push("the pill never went back to its ID");
      else if (Date.now() - t0 < 900) v.push(`"Copied" held only ${Date.now() - t0} ms (want ≈ 1200)`);
      const got = await clipboard.readText();
      if (got !== id) v.push(`the clipboard holds ${J(got)}, want ${J(id)}`);
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
      await setSettings({ SettingsLevel: "expert", TransitionMethod: "full-live", FullLiveSyncOffsetMs: -40 });
      try {
        await load();
        if (!(await has("Transition style"))) return ['no "Transition style" row at Expert — proved nothing'];
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

    await cell("bg:onePoll — the live background behind Settings reads /current one at a time while the backend is slow", async () => {
      await setSettings({ SettingsLevel: "standard" }); await load();
      if (!(await js(`return !!document.querySelector("video.settings-bg")`))) return ["no live background behind Settings — proved nothing"];
      // every /current answer is held 7 s once its headers arrive (a backend that answers late), and the reads open at
      // once are counted from the page's own requests
      const wr = session.defaultSession.webRequest, f = { urls: ["*://127.0.0.1/current*"] }, open = new Set(), held = new Set();
      let most = 0, asked = 0;
      wr.onSendHeaders(f, (d) => { open.add(d.id); asked++; most = Math.max(most, open.size); });
      wr.onCompleted(f, (d) => open.delete(d.id)); wr.onErrorOccurred(f, (d) => open.delete(d.id));
      wr.onHeadersReceived(f, (d, cb) => { const go = () => { held.delete(go); clearTimeout(t); cb({}); }, t = setTimeout(go, 7000); held.add(go); });
      let after;
      try {
        await sleep(7500);
        for (const go of [...held]) go();
        const n = asked; after = await waitFor(() => asked > n, SAVE_MS, 50);
      } finally { wr.onSendHeaders(f, null); wr.onCompleted(f, null); wr.onErrorOccurred(f, null); wr.onHeadersReceived(f, null); for (const go of [...held]) go(); }
      const v = [];
      if (!asked) return ["the background never read /current in 7.5 s — proved nothing"];
      if (most > 1) v.push(`${most} /current reads open at once while each answer took 7 s (one at a time: the page has 6 connections to the API)`);
      if (!after) v.push("no fresh /current read once the slow one answered (a sync asked meanwhile is owed)");
      return v;
    });

    await cell("vram:stopShows — \"Stopped scene shows\" sits under the cap, a Last frame / Nothing switch that saves sceneVramStopShows", async () => {
      const v = [];
      const eng = (await http("GET", "/player-engine")).json?.active;
      if (eng !== "liascape-player") return [`the stack runs ${J(eng)}, not liascape-player — proved nothing`];
      const ROW = "Stopped scene shows";
      await setSettings({ SettingsLevel: "expert", LimitVramPerScene: false, SceneVramStopShows: "last_frame" });
      try {
        await load();
        if (!(await has("Cap each scene's video memory"))) return ['no "Cap each scene\'s video memory" row at Expert — proved nothing'];
        if (await has(ROW)) v.push(`the cap off: "${ROW}" shows (it means nothing then)`);
        await setSettings({ LimitVramPerScene: true }); await load();
        const r = await js(`const r = window.__x.row(${J(ROW)}); if (!r) return null;
          const rows = [...document.querySelectorAll(".settings .srow")].map((x) => window.__x.label(x));
          const seg = r.querySelector(".sctl > .seg.row");
          return { after: rows[rows.indexOf(${J(ROW)}) - 1], seg: !!seg, opts: [...(seg?.querySelectorAll(".seg-opt") ?? [])].map((b) => b.textContent.trim()),
            on: seg?.querySelector('[aria-checked="true"]')?.textContent.trim(), native: !!r.querySelector("select"), hint: r.querySelector(".shint")?.textContent ?? "" }`);
        if (!r) return [...v, `the cap on: no "${ROW}" row`];
        if (r.after !== "Video memory cap (MiB)") v.push(`"${ROW}" follows ${J(r.after)}, want "Video memory cap (MiB)"`);
        if (!r.seg || r.native) v.push(`"${ROW}" isn't the shared Segmented switch (${J(r)})`);
        if (J(r.opts) !== J(["Last frame", "Nothing"])) v.push(`options ${J(r.opts)}, want ["Last frame","Nothing"]`);
        if (r.on !== "Last frame") v.push(`the default shows ${J(r.on)} chosen, want "Last frame"`);
        if (/—|;|·/.test(r.hint)) v.push(`the hint breaks the Settings words (em dash, semicolon or ·): ${J(r.hint)}`);
        const p = await js(`return await window.__x.show([...window.__x.row(${J(ROW)}).querySelectorAll(".seg-opt")].find((b) => b.textContent.trim() === "Nothing"))`);
        await clickAt(p.x, p.y);
        if (!(await waitFor(async () => (await field("sceneVramStopShows")) === "nothing", SAVE_MS))) v.push(`a click on Nothing didn't save sceneVramStopShows (${await field("sceneVramStopShows")})`);
        const on = await js(`return window.__x.row(${J(ROW)})?.querySelector('.seg-opt[aria-checked="true"]')?.textContent.trim()`);
        if (on !== "Nothing") v.push(`after the click the switch shows ${J(on)} chosen`);
        await setSettings({ SettingsLevel: "advanced" }); await load();
        if (await has(ROW)) v.push(`Advanced: "${ROW}" shows (it's an Expert row)`);
        if ((await field("sceneVramStopShows")) !== "nothing") v.push(`hiding the row changed the saved value: ${await field("sceneVramStopShows")}`);
      } finally {
        await setSettings({ SettingsLevel: "standard", LimitVramPerScene: false, SceneVramStopShows: "last_frame" });
      }
      return v;
    });

    await cell("fonts:rows — \"Use Windows fonts in scenes\" under Play scenes saves useWindowsFonts; the folder row dims while it's off", async () => {
      const v = [];
      const eng = (await http("GET", "/player-engine")).json?.active;
      if (eng !== "liascape-player") return [`the stack runs ${J(eng)}, not liascape-player — proved nothing`];
      const ON = "Use Windows fonts in scenes", DIR = "Windows fonts folder";
      await setSettings({ SettingsLevel: "expert", UseWindowsFonts: true, WindowsFontsFolder: "" });
      try {
        await load();
        const read = () => js(`const rows = [...document.querySelectorAll(".settings .srow")].map((x) => window.__x.label(x));
          const on = window.__x.row(${J(ON)}), dir = window.__x.row(${J(DIR)});
          return { before: rows[rows.indexOf(${J(ON)}) - 1], next: rows[rows.indexOf(${J(ON)}) + 1], label: on?.tagName,
            ticked: on?.querySelector("input[type=checkbox]")?.checked, onHint: on?.querySelector(".shint")?.textContent ?? "",
            dir: !!dir, dirHint: dir?.querySelector(".shint")?.textContent ?? "", dirOff: dir?.classList.contains("disabled"),
            input: dir?.querySelector("input.text") ? { disabled: dir.querySelector("input.text").disabled, ph: dir.querySelector("input.text").placeholder } : null,
            browse: dir ? [...dir.querySelectorAll("button")].map((b) => ({ t: b.textContent.trim(), disabled: b.disabled, svg: !!b.querySelector("svg") })) : [] }`);
        const r = await read();
        if (!r.dir && r.label === undefined) return [`no "${ON}" row at Expert under liascape-player — proved nothing`];
        if (r.before !== "Play scenes") v.push(`"${ON}" follows ${J(r.before)}, want "Play scenes"`);
        if (r.next !== DIR) v.push(`"${ON}" is followed by ${J(r.next)}, want "${DIR}"`);
        if (r.label !== "LABEL") v.push(`"${ON}" isn't a checkbox <label> row (${r.label})`);
        if (r.ticked !== true) v.push(`on by default: the box shows ${r.ticked}`);
        for (const [n, h] of [[ON, r.onHint], [DIR, r.dirHint]]) {
          if (/—|;|·/.test(h)) v.push(`${n}: the hint breaks the Settings words (em dash, semicolon or ·): ${J(h)}`);
          if (!/^[a-z]/.test(h)) v.push(`${n}: the hint doesn't start lowercase: ${J(h)}`);
        }
        if (!r.input || r.input.disabled || r.dirOff) v.push(`the toggle on: the folder field is off (${J(r)})`);
        if (!r.input?.ph) v.push("the empty folder field says nothing (no placeholder)");
        const br = r.browse.find((b) => b.t === "Browse");
        if (!br || !br.svg || br.disabled) v.push(`the folder row's Browse button (icon, enabled): ${J(r.browse)}`);
        await js(`await window.__x.show(window.__x.row(${J(ON)})); return true`);
        const at = await js(`const r = window.__x.row(${J(ON)}).getBoundingClientRect(), d = window.__x.row(${J(DIR)}).getBoundingClientRect();
          return { x: Math.round(r.x) - 8, y: Math.round(r.y) - 8, width: Math.round(r.width) + 16, height: Math.round(d.bottom - r.y) + 16 }`);
        await shot("fonts-on", at);
        // the folder, typed: saved as it is
        await js(`const i = window.__x.row(${J(DIR)}).querySelector("input.text"); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
          set.call(i, "/mnt/win/Windows/Fonts"); i.dispatchEvent(new Event("input", { bubbles: true })); return true`);
        if (!(await waitFor(async () => (await field("windowsFontsFolder")) === "/mnt/win/Windows/Fonts", SAVE_MS))) v.push(`typing the folder didn't save windowsFontsFolder (${J(await field("windowsFontsFolder"))})`);
        // a click on the row's name unticks it: saved, and the folder row stays but dims and turns off
        const p = await js(`return await window.__x.show(window.__x.row(${J(ON)}).querySelector(".slabel-row"))`);
        await clickAt(p.x, p.y);
        if (!(await waitFor(async () => (await field("useWindowsFonts")) === false, SAVE_MS))) v.push(`a click on "${ON}" didn't save useWindowsFonts false (${await field("useWindowsFonts")})`);
        await sleep(300);
        const off = await read();
        if (!off.dir) v.push(`the toggle off: "${DIR}" left the page (it dims, never pops out)`);
        else if (!off.dirOff || !off.input?.disabled || !off.browse.find((b) => b.t === "Browse")?.disabled) v.push(`the toggle off: the folder row isn't dimmed and disabled (${J(off)})`);
        await mv(5, 5, 300);
        await shot("fonts-off", at);
        await clickAt(p.x, p.y);
        if (!(await waitFor(async () => (await field("useWindowsFonts")) === true, SAVE_MS))) v.push(`a second click didn't save useWindowsFonts true`);
        await mv(p.x, p.y, 400); await shot("fonts-hover", at);
        await js(`document.documentElement.classList.add("no-glow"); return true`); await sleep(300); await shot("fonts-hover-noglow", at);
        await js(`document.documentElement.classList.remove("no-glow"); document.documentElement.classList.add("bg-live"); return true`); await sleep(300);
        await shot("fonts-bglive", at);
        await js(`document.documentElement.classList.remove("bg-live"); return true`); await mv(5, 5);
        await setSettings({ SettingsLevel: "advanced" }); await load();
        if (!(await has(ON))) v.push(`Advanced: no "${ON}" row (it's an Advanced row)`);
        if (await has(DIR)) v.push(`Advanced: "${DIR}" shows (it's an Expert row)`);
        await setSettings({ SettingsLevel: "standard" }); await load();
        if (await has(ON)) v.push(`Standard: "${ON}" shows (it's an Advanced row)`);
        if ((await field("windowsFontsFolder")) !== "/mnt/win/Windows/Fonts") v.push(`hiding the folder row changed its value: ${J(await field("windowsFontsFolder"))}`);
      } finally {
        await setSettings({ SettingsLevel: "standard", UseWindowsFonts: true, WindowsFontsFolder: "" });
      }
      return v;
    });

    // ---- Settings levels: the rows the re-tier moved, each shown from exactly its level; never a heading with no row under
    // it (app/ui/src/settingsLevel.ts, views/Settings.tsx Row / Section)
    const LEVELS = ["basic", "standard", "advanced", "expert"];
    // label → the level it shows from (liascape-player; normalization, the scene memory cap and the steamcmd route on)
    const MOVED = {
      "Loudness target": "advanced", "Fade out after (ms)": "advanced", "Come back after (ms)": "advanced",
      "Disable video cache": "expert", "Restart legacy player every (s)": "expert", "Only restart between wallpapers": "expert",
      "Fit to screen": "basic", "Read-ahead buffer (MiB)": "expert", "Look-back buffer (MiB)": "expert",
      "Stopped scene shows": "expert", "Keep a scene renderer ready": "advanced",
      "Thumbnail shape": "basic", "Smooth window animations": "basic", "Text shadow": "advanced", "On hover": "advanced",
      "Not hovered": "advanced", "Wallpaper behind every tab": "standard",
      "Use Windows fonts in scenes": "advanced", "Windows fonts folder": "expert",
      "Download via steamcmd": "advanced", "steamcmd path": "advanced", "Steam username": "advanced", "Sign in": "advanced",
      "Autostart": "basic", "Forget the whole library": "advanced",
      // neighbours that stay: their sections' other rows keep their own levels
      "Video frame rate cap": "standard", "Hardware decoding": "advanced", "toggle-mute": "standard", "Clear cached files": "basic",
    };
    // every shown section (a heading on screen) holds a row, a command block or a button; the headings per level
    const sectionsAt = () => js(`return [...document.querySelectorAll(".settings .ssection")].filter((s) => getComputedStyle(s).display !== "none").map((s) => ({
      title: s.querySelector("h3")?.textContent.trim(), rows: [...s.querySelectorAll(".srow")].filter((r) => r.getClientRects().length).length,
      other: [...s.querySelectorAll(".cmd-block, .btn")].filter((e) => e.getClientRects().length).length }))`);
    const emptyAt = (secs) => secs.filter((s) => !s.rows && !s.other).map((s) => s.title);

    await cell("levels:rows — every row the re-tier moved shows from exactly its level, its section's other rows keep theirs", async () => {
      const v = [];
      const eng = (await http("GET", "/player-engine")).json?.active;
      if (eng !== "liascape-player") return [`the stack runs ${J(eng)}, not liascape-player — proved nothing`];
      try {
        await setSettings({ NormalizeAudio: true, NoAudio: false, LimitVramPerScene: true, WorkshopDownloadMode: "steamcmd" });
        for (const lv of LEVELS) {
          await setSettings({ SettingsLevel: lv }); await load();
          const seen = await js(`return Object.fromEntries(${J(Object.keys(MOVED))}.map((l) => [l, !!window.__x.row(l)]))`);
          for (const [label, from] of Object.entries(MOVED)) {
            const want = LEVELS.indexOf(lv) >= LEVELS.indexOf(from);
            if (seen[label] !== want) v.push(`${lv}: "${label}" ${seen[label] ? "shows" : "is missing"} (it's a ${from} row)`);
          }
        }
      } finally {
        await setSettings({ SettingsLevel: "standard", NormalizeAudio: false, LimitVramPerScene: false, WorkshopDownloadMode: "subscribe" });
      }
      return v;
    });

    for (const engine of ["liascape-player", "legacy"]) {
      await cell(`levels:noEmptySection:${engine} — at every level no section heading shows without a row under it`, async () => {
        const v = [];
        try {
          for (const lv of LEVELS) {
            await setSettings({ SettingsLevel: lv }); await load(engine === "legacy" ? { engine } : {});
            const secs = await sectionsAt();
            if (secs.length < 5) { v.push(`${lv}: only ${secs.length} sections shown — proved nothing`); continue; }
            for (const t of emptyAt(secs)) v.push(`${lv}: "${t}" shows its heading with nothing under it`);
            const titles = secs.map((s) => s.title);
            // the legacy-only "Scene transition delay (ms)" moved to Expert
            if (engine === "legacy" && (await has("Scene transition delay (ms)")) !== (lv === "expert"))
              v.push(`${lv}, legacy: "Scene transition delay (ms)" ${lv === "expert" ? "is missing" : "shows"} (it's an expert row)`);
            // Basic: the Video and Keyboard shortcuts sections open for their one Basic row each; Playback's only Basic row is
            // liascape-player's, so under legacy it hides at Basic
            if (lv === "basic") {
              for (const [t, row] of [["Video", "Fit to screen"], ["Keyboard shortcuts", "Autostart"]]) {
                const s = secs.find((x) => x.title === t);
                if (!s) v.push(`basic: no "${t}" section (its "${row}" row is Basic)`);
                else if (s.rows !== 1) v.push(`basic: "${t}" shows ${s.rows} rows, want just "${row}"`);
              }
              if (engine === "legacy" && titles.includes("Playback")) v.push("basic, legacy: the Playback heading shows (its only Basic row is liascape-player's)");
              if (engine === "liascape-player" && !titles.includes("Playback")) v.push("basic, liascape-player: no Playback section (Pause behind windows is Basic)");
            }
          }
        } finally { await setSettings({ SettingsLevel: "standard" }); }
        return v;
      });
    }

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
      await waitFor(() => js(`return +getComputedStyle(document.querySelector("[data-cache-freed]")).opacity > 0.95`), SAVE_MS);
      const fc = await js(`return getComputedStyle(document.querySelector("[data-cache-freed]")).color`);
      if (fc !== await C("var(--success)")) v.push(`"Freed" is ${fc}, want --success ${await C("var(--success)")}`);
      await mv(5, 5, 900);
      await shot("cache-freed", rect);
      return v;
    });

    // ---- Sound: the mute button at the end of the Volume row (components/MuteButton.tsx, the sidebar's chip) ----
    // what the page shows of the Volume row and its mute button; `eff` = an element's opacity as seen (the product up the tree)
    const MUTE_READ = `const r = window.__x.row("Volume"), b = r?.querySelector("[data-wall-mute]"), s = r?.querySelector("input[type=range]"), n = window.__x.row("Audio normalization");
      const eff = (e) => { let o = 1; for (let x = e; x && x.nodeType === 1; x = x.parentElement) o *= +getComputedStyle(x).opacity; return +o.toFixed(3); };
      const bx = b?.getBoundingClientRect(), sx = s?.getBoundingClientRect(), rx = r?.getBoundingClientRect();
      return { row: !!r, btn: !!b, tag: b?.tagName, label: b?.getAttribute("aria-label"), pressed: b?.getAttribute("aria-pressed"), on: b?.classList.contains("side-mute") && b.classList.contains("on"),
        glyph: b?.querySelector("svg")?.getAttribute("class")?.match(/lucide-[a-z0-9-]+/g)?.pop(), hint: r?.querySelector(".shint")?.textContent,
        sliderDisabled: s?.disabled, sliderOp: s ? eff(s) : null, labelOp: r ? eff(r.querySelector(".slabel")) : null, btnOp: b ? eff(b) : null, rowOp: r ? eff(r) : null,
        normOp: n ? eff(n) : null, boxes: !!r?.querySelector("input[type=checkbox]"),
        geo: bx && { w: bx.width, h: bx.height, dx: +(bx.left - sx.right).toFixed(1), dy: +((bx.top + bx.height / 2) - (sx.top + sx.height / 2)).toFixed(1), dr: +(rx.right - 9 - bx.right).toFixed(1) } }`;
    const muteRead = () => js(MUTE_READ);
    // the Volume row and the one below it, for the pictures
    const muteRect = () => js(`const r = window.__x.row("Volume").getBoundingClientRect(), n = window.__x.row("Audio normalization").getBoundingClientRect();
      return { x: Math.round(r.x) - 8, y: Math.round(r.y) - 8, width: Math.round(r.width) + 16, height: Math.round(n.bottom - r.top) + 16 }`);
    const muteAt = () => js(`return await window.__x.show(window.__x.row("Volume")?.querySelector("[data-wall-mute]"))`);

    for (const level of ["basic", "expert"]) {
      await cell(`mute:row:${level} — Sound has no "Mute wallpapers" row; the Volume row ends in the shared mute chip, which saves noAudio and dims the slider`, async () => {
        const v = [];
        await setSettings({ SettingsLevel: level, NoAudio: false, Volume: 70, NormalizeAudio: true }); await load();
        if (await has("Mute wallpapers")) v.push('the row "Mute wallpapers" is still there (the checkbox)');
        let st = await muteRead();
        if (!st.row) return [...v, 'no "Volume" row'];
        if (!st.btn) return [...v, "the Volume row has no [data-wall-mute] button"];
        if (st.boxes) v.push("the Volume row still holds a checkbox");
        if (st.tag !== "BUTTON" || !st.on) v.push(`the control isn't the sidebar's chip (${J({ tag: st.tag, on: st.on })}): want button.side-mute.on while sound plays`);
        if (st.label !== "Mute wallpapers" || st.pressed !== "true") v.push(`sound on: aria-label ${J(st.label)} / aria-pressed ${J(st.pressed)}, want "Mute wallpapers" / "true"`);
        if (st.glyph !== "lucide-volume-2") v.push(`sound on: the glyph is ${st.glyph}, want lucide-volume-2`);
        if (st.hint !== "70%") v.push(`sound on: the Volume hint reads ${J(st.hint)}, want "70%"`);
        if (st.sliderDisabled || st.sliderOp < 0.99 || st.btnOp < 0.99) v.push(`sound on: slider disabled ${st.sliderDisabled}, slider ${st.sliderOp} / chip ${st.btnOp} opacity`);
        if (st.geo && (Math.abs(st.geo.w - 32) > 0.5 || Math.abs(st.geo.h - 32) > 0.5)) v.push(`the chip is ${st.geo.w}×${st.geo.h}, want 32×32 like the sidebar's`);
        if (st.geo && st.geo.dx < 4) v.push(`the chip isn't after the slider (its left is ${st.geo.dx}px from the slider's right)`);
        if (st.geo && Math.abs(st.geo.dy) > 1.5) v.push(`the chip is ${st.geo.dy}px off the slider's centre line`);
        if (st.geo && Math.abs(st.geo.dr) > 1.5) v.push(`the chip's right edge is ${st.geo.dr}px from the row's control edge`);
        const p = await muteAt();
        await shot(`mute-${level}-on`, await muteRect());
        await clickAt(p.x, p.y);
        if (!(await waitFor(async () => (await field("noAudio")) === true, SAVE_MS))) return [...v, `a click saved noAudio ${await field("noAudio")}, want true`];
        await waitFor(async () => (await muteRead()).label === "Unmute wallpapers", 3000); await sleep(450);
        st = await muteRead();
        if (st.label !== "Unmute wallpapers" || st.pressed !== "false" || st.on) v.push(`muted: aria-label ${J(st.label)} / pressed ${J(st.pressed)} / on ${st.on}, want "Unmute wallpapers" / "false" / off`);
        if (st.glyph !== "lucide-volume-x") v.push(`muted: the glyph is ${st.glyph}, want lucide-volume-x`);
        if (st.hint !== "muted") v.push(`muted: the Volume hint reads ${J(st.hint)}, want "muted"`);
        if (!st.sliderDisabled) v.push("muted: the slider is still enabled");
        if (!(st.sliderOp > 0.3 && st.sliderOp < 0.6) || !(st.labelOp > 0.3 && st.labelOp < 0.6)) v.push(`muted: slider ${st.sliderOp} / label ${st.labelOp} opacity, want ≈ .45 (dimmed)`);
        if (st.btnOp < 0.99 || st.rowOp < 0.99) v.push(`muted: the chip is dimmed with the row (chip ${st.btnOp}, row ${st.rowOp}) — it is the way back`);
        if (!(st.normOp > 0.3 && st.normOp < 0.6)) v.push(`muted: "Audio normalization" opacity ${st.normOp}, want ≈ .45 (dimmed as before)`);
        await shot(`mute-${level}-muted`, await muteRect());
        await clickAt(p.x, p.y);
        if (!(await waitFor(async () => (await field("noAudio")) === false, SAVE_MS))) return [...v, `a second click saved noAudio ${await field("noAudio")}, want false`];
        await waitFor(async () => (await muteRead()).label === "Mute wallpapers", 3000);
        st = await muteRead();
        if (st.sliderDisabled || !st.on) v.push(`unmuted again: slider disabled ${st.sliderDisabled}, chip on ${st.on}`);
        await mv(5, 5);
        await setSettings({ SettingsLevel: "standard", NormalizeAudio: false });
        return v;
      });
    }

    // the Volume row's reset puts the sound back as well as the level: shown while muted or off 100 %, one click → sound at
    // 100 %, and gone at 100 % with sound
    await cell("mute:reset — the Volume row's reset unmutes and puts the level back to 100 %; it shows only while either is off", async () => {
      const v = [];
      const resetBtn = () => js(`const b = window.__x.row("Volume")?.querySelector(".s-reset"); return b ? await window.__x.show(b) : null`);
      await setSettings({ SettingsLevel: "standard", NoAudio: false, Volume: 100 }); await load();
      if (await resetBtn()) v.push("sound on at 100 %: the Volume row shows a reset button (nothing is off)");
      await setSettings({ NoAudio: true, Volume: 70 }); await load();
      const p = await resetBtn();
      if (!p) return [...v, "muted at 70 %: the Volume row has no reset button"];
      await clickAt(p.x, p.y);
      if (!(await waitFor(async () => (await field("noAudio")) === false && (await field("volume")) === 100, SAVE_MS)))
        v.push(`after the reset: noAudio ${await field("noAudio")} / volume ${await field("volume")}, want false / 100`);
      if (!(await waitFor(async () => !(await resetBtn()), 3000))) v.push("after the reset the reset button still shows");
      await setSettings({ NoAudio: true, Volume: 100 }); await load();
      if (!(await resetBtn())) v.push("muted at 100 %: no reset button (muted is off the sound)");
      await mv(5, 5);
      await setSettings({ NoAudio: false, Volume: 100 });
      return v;
    });

    // the glyph pops once on the user's click (motion on: in-between sizes; off / prefers-reduced-motion: it just swaps) and
    // never on load; the slider's dimming eases in either way (a fade is allowed with motion off)
    for (const mode of ["on", "off", "reduced"]) {
      await cell(`mute:motion:${mode} — the new glyph pops on a click (motion on), only swaps with motion ${mode === "on" ? "off" : mode}; nothing pops on load`, async () => {
        await setSettings({ SettingsLevel: "standard", Morphs: mode !== "off", NoAudio: false, Volume: 70 }); await reducedMotion(mode === "reduced"); await load();
        try {
          const noMotion = await js(`return document.documentElement.classList.contains("no-motion")`);
          if (noMotion !== (mode !== "on")) return [`:root.no-motion is ${noMotion} under motion ${mode} — proved nothing`];
          const v = [];
          if (await js(`return !!window.__x.row("Volume")?.querySelector("[data-wall-mute] .ico-pop")`)) v.push("the glyph pops on load (.ico-pop before any click)");
          const p = await muteAt(); if (!p) return [...v, "no [data-wall-mute] button"];
          const samp = js(`return await (() => new Promise((res) => { const out = []; const t0 = performance.now();
            const f = () => { const t = Math.round(performance.now() - t0), b = window.__x.row("Volume")?.querySelector("[data-wall-mute]"), g = b?.querySelector(".side-mute-ico"), s = window.__x.row("Volume")?.querySelector("input[type=range]");
              out.push({ t, scale: g ? +new DOMMatrix(getComputedStyle(g).transform).a.toFixed(3) : null, anims: g ? g.getAnimations().map((a) => Object.keys(a.effect.getKeyframes()[0] ?? {}).filter((k) => !["offset", "easing", "composite", "computedOffset"].includes(k)).join("+")) : [],
                glyph: b?.querySelector("svg")?.getAttribute("class")?.match(/lucide-[a-z0-9-]+/g)?.pop(), slider: s ? +getComputedStyle(s).opacity : null });
              if (t < 1100) requestAnimationFrame(f); else res(out); }; requestAnimationFrame(f); }))()`);
          await sleep(80); await clickAt(p.x, p.y);
          if (mode === "on") { await sleep(40); await shot("mute-pop-mid", await muteRect()); }
          const fr = await samp;
          if (!(await waitFor(async () => (await field("noAudio")) === true, SAVE_MS))) return [...v, "the click saved nothing — proved nothing"];
          const k = fr.findIndex((f) => f.glyph === "lucide-volume-x");
          if (k < 0) return [...v, `the glyph never turned to volume-x in the frames (${J([...new Set(fr.map((f) => f.glyph))])}) — proved nothing`];
          const after = fr.slice(k), mids = after.filter((f) => f.scale != null && f.scale > 0.62 && f.scale < 0.98);
          if (mode === "on") {
            if (mids.length < 3) v.push(`motion on: the new glyph popped through only ${mids.length} in-between sizes (want ≥ 3: ${J(after.slice(0, 8).map((f) => f.scale))})`);
            const props = [...new Set(after.flatMap((f) => f.anims))].filter((x) => x && !/^(transform|scale|opacity)$/.test(x));
            if (props.length) v.push(`motion on: the pop animates ${J(props)}, want transform / opacity only`);
          } else {
            const moved = after.filter((f) => f.scale != null && Math.abs(f.scale - 1) > 0.01);
            if (moved.length) v.push(`motion ${mode}: the glyph changed size in ${moved.length} frames (${J(moved[0])}), want a plain swap`);
          }
          const dim = fr.filter((f) => f.slider != null).map((f) => f.slider);
          if (Math.min(...dim) > 0.5) v.push(`the slider never dimmed in the frames (min opacity ${Math.min(...dim)})`);
          await shot(`mute-motion-${mode}`, await muteRect());
          return v;
        } finally { await reducedMotion(false); await mv(5, 5); await setSettings({ NoAudio: false, Morphs: true }); }
      });
    }

    await cell("mute:look — theme colours, hover glow (none under no-glow), bg-live; pictures", async () => {
      const v = [];
      await setSettings({ SettingsLevel: "standard", Morphs: true, Glows: true, NoAudio: false, Volume: 70 }); await load();
      const C = (expr) => js(`const p = document.createElement("i"); p.style.color = ${J(expr)}; document.body.append(p); const c = getComputedStyle(p).color; p.remove(); return c`);
      const lit = (sh) => !!sh && sh !== "none" && sh.split(/,(?![^(]*\))/).some((part) => {
        const m = /rgba?\(([^)]*)\)/.exec(part); if (!m) return false; const c = m[1].split(",").map(Number); return c.length < 4 || c[3] > 0; });
      const read = () => js(`const b = window.__x.row("Volume")?.querySelector("[data-wall-mute]"), cs = getComputedStyle(b); return { shadow: cs.boxShadow, bg: cs.backgroundColor, color: cs.color, border: cs.borderTopColor }`);
      const p = await muteAt(); if (!p) return ["no [data-wall-mute] button"];
      const rect = await muteRect();
      await mv(5, 5, 300);
      const on = await read();
      if (on.bg !== await C("var(--accent)") || on.color !== await C("var(--accent-fg)")) v.push(`sound on: ${J(on)} want the accent fill (${await C("var(--accent)")}) and --accent-fg text`);
      if (lit(on.shadow)) v.push(`at rest it glows (${on.shadow})`);
      await shot("mute-look-rest", rect);
      await mv(p.x, p.y, 400);
      if (!lit((await read()).shadow)) v.push(`hovered, no glow (${(await read()).shadow})`);
      await shot("mute-look-hover", rect);
      await js(`document.documentElement.classList.add("no-glow"); return true`); await sleep(300);
      if (lit((await read()).shadow)) v.push(`no-glow: still glowing (${(await read()).shadow})`);
      await shot("mute-look-noglow", rect);
      await js(`document.documentElement.classList.remove("no-glow"); document.documentElement.classList.add("bg-live"); return true`); await sleep(300);
      await shot("mute-look-bglive-on", rect);
      await js(`document.documentElement.classList.remove("bg-live"); return true`);
      await clickAt(p.x, p.y);
      if (!(await waitFor(async () => (await field("noAudio")) === true && (await muteRead()).label === "Unmute wallpapers", SAVE_MS))) return [...v, "a click never muted — proved nothing"];
      await mv(5, 5, 400);
      const off = await read();
      if (off.color !== await C("var(--text)")) v.push(`muted: the glyph is ${off.color}, want --text ${await C("var(--text)")}`);
      const a = /\/\s*([0-9.]+)\s*\)$/.exec(off.bg)?.[1] ?? /rgba\([^)]*,\s*([0-9.]+)\)/.exec(off.bg)?.[1] ?? 1;
      if (!(+a < 1)) v.push(`muted: the chip's fill ${off.bg} is opaque (want the sidebar chip's see-through material)`);
      await shot("mute-look-muted", rect);
      await js(`document.documentElement.classList.add("bg-live"); return true`); await sleep(300);
      await shot("mute-look-bglive-muted", rect);
      await js(`document.documentElement.classList.remove("bg-live"); return true`);
      await mv(5, 5);
      await setSettings({ NoAudio: false });
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
