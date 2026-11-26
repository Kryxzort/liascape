// Import probe — `scripts/test-ui-matrix.sh --probe probe-import.js` (the matrix's hermetic stack: private backend + headless
// liascape-player + this tree's UI, on a private Xvfb). The import dialog (components/ImportDialog.tsx), the Library's Import
// button and the window's drop frame (components/ImportButton.tsx), Settings → Watched folders (views/Settings.tsx).
// The page has no preload here: a cell stands in for the shell's picker by setting window.liascape.pickFolder.
//   import:button:<m>   Library → Import → the picked folder: the dialog appears (motion on: it zooms in through in-between
//                       frames; off / reduced: it only fades), says "2 videos, 1 GIF, 1 picture, 1 scene, 1 already in your
//                       library", groups by kind with every new item ticked, the one the library has unticked + disabled with
//                       "In your library"; unticking one makes its group's tick mixed and the button "Import 4"; Import lands
//                       exactly the four ticked (links: "Copy files instead of linking" off by default) and the dialog leaves
//   import:cancel       Cancel, Escape and a click outside each close it and land nothing
//   import:files:<m>    the Import's chevron is in sight beside it (its height, in the top bar, aria-haspopup); a click opens
//                       its menu ("Import a folder…", "Import files…", "Import from a link…") with the chevron turned over (motion on: through
//                       in-between angles while the menu grows in; off / reduced: it flips at once, the menu only fades);
//                       Import files… opens the dialog on just the picked files
//   import:files:keys   ↓ on the chevron opens the menu on its first entry, Escape gives the focus back to the chevron,
//                       Enter opens it again, ↓ Enter picks files: the dialog on just them
//   import:files:rightClick  a right-click on Import opens the same menu; a plain click on Import still picks a folder
//   import:drop:<m>     files dragged over the window from a file manager (text/uri-list file:// URIs) show the drop frame
//                       (motion on: it scales in; off: it fades), leaving the window hides it, a drop opens the dialog on them
//   import:settings     Settings → "Add folder" opens the dialog as "Watch a folder" with "Keep watching this folder" ticked;
//                       importing lists the folder in Watched folders with its wallpaper count (all six); its "Copy files instead of
//                       linking" saves the folder's copy choice; a file written into the folder shows up in the Library
//                       without a click; the remove button stops the watching (the section on screen: motion on, the row
//                       fades in place, never sideways, while "Add folder" glides up through in-between frames, never back
//                       down, never clipped by the card; off, the row fades and "Add folder" then jumps, no in-between
//                       frame) and keeps the wallpapers; the section below glides up with the card's bottom edge (motion
//                       off: it jumps), and on an add glides down while the card grows (picture import-settings-add-on.png)
//   import:steam        a folder holding a Steam library's Workshop folder (a fake libraryfolders.vdf in the stack's HOME):
//                       its items listed apart, last, as "From your Steam subscriptions" (the summary says how many), the
//                       group's tick and every item unticked and disabled, its line naming "Import new Workshop wallpapers"
//                       (off: turn it on in Settings; on: it brings them in) in --subtext, the chip in --accent; the user's
//                       own file beside them ticked; Import lands only that file, nothing linked into Steam's folder;
//                       picture import-steam.png (also under no-glow and bg-live: the dialog keeps its fill)
//   import:look         theme colours (the in-library pill in --success, the group chips in --accent), the drop frame's
//                       glow (none under no-glow), bg-live: the dialog keeps its own fill; pictures import-*.png
//   import:link:<m>     the Import menu's "Import from a link…" opens the dialog on an empty link field, focused, Import off
//                       (motion on: it zooms in; off / reduced: it only fades); an unknown site's page says it isn't supported;
//                       a file's link (this probe's own file server on loopback) shows what it is (motion on: the line rises
//                       in through in-between frames; off: it only fades), Import downloads it with a Browse card's progress
//                       bar (filling through in-between widths; "Importing…", Cancel turned "Close") that fades in, then the
//                       dialog leaves, the item lands with its card and the status line says "Imported: …"
//                       (pictures import-link-found-<m>.png, import-link-progress-<m>.png)
//   import:link:paste   a web link pasted on the Library opens the dialog on it, resolved at once; plain text, a paste in the
//                       search field and a paste on Browse open nothing; a link the library has (the cell imports its own)
//                       shows "In your library", Import off
//   import:link:drop    a web link dragged from a browser (text/uri-list http) opens the dialog on it
//   import:link:close   Close while it imports: the dialog leaves at once, the import goes on and lands, the status says so
//   import:link:error   a page served as video/mp4: the import's refusal shows under what the link names, which stays with
//                       Import on; Import again asks the server again and says the same; an edit of the link clears it
//   import:link:look    the error line in --danger, where it comes from in --subtext, the chip in --accent, the progress fill
//                       in --accent with its glow (none under no-glow), bg-live keeps the dialog's fill; pictures
// Exit 1 on any FAIL. LIASCAPE_ONLY = a regex over the cell names.
const { app, BrowserWindow } = require("electron");
const cp = require("child_process");
const fs = require("fs");
const path = require("path");
const { SAMPLE, judge, brief } = require("./motion-off");

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
const setSettings = (patch) => http("POST", "/settings", patch);
const library = async () => (await http("GET", "/library")).json ?? [];
const titles = async () => (await library()).map((i) => i.title);

let win;
// every step has its own ceiling: a hung page step fails its cell instead of holding the test lock
const within = (p, ms, what) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(`${what}: no answer in ${ms / 1000} s`)), ms))]);
const js = (code) => within(win.webContents.executeJavaScript(`(async () => { ${code} })()`), 30000, "page script");
async function reducedMotion(on) {
  const d = win.webContents.debugger;
  if (!d.isAttached()) d.attach("1.3");
  await within(d.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: on ? "reduce" : "" }] }), 10000, "reduced motion");
}
async function shot(name, sel) {
  const r = sel ? await js(`const e = document.querySelector(${J(sel)}); if (!e) return null; e.scrollIntoView({ block: "nearest" });
    await new Promise((res) => setTimeout(res, 400)); const b = e.getBoundingClientRect();
    return { x: Math.max(0, Math.floor(b.x) - 8), y: Math.max(0, Math.floor(b.y) - 8), width: Math.ceil(b.width) + 16, height: Math.ceil(b.height) + 16 }`) : null;
  const img = await win.webContents.capturePage(r ?? undefined);
  fs.writeFileSync(path.join(OUT, `import-${name}.png`), img.toPNG());
}
async function load() {
  await win.loadURL(withToken(U + "/"));
  for (let i = 0; i < 100 && !(await js(`return !!document.querySelector(".tab")`)); i++) await sleep(100);
  await js(`[...document.querySelectorAll(".tab")].find((t) => t.textContent.trim() === "Library")?.click(); return true`);
  await waitFor(() => js(`return !!document.querySelector("[data-import-btn]")`), 8000);
}
// the shell's picker, stood in for: the next pickFolder / pickFiles answers these
const stubPicker = (folder, files = null) => js(`window.liascape = { pickFolder: async () => ${J(folder)}, pickFiles: async () => ${J(files)} }; return true`);
const dialog = () => js(`const d = document.querySelector("[data-import-dialog]"); if (!d) return null;
  return { state: d.dataset.importDialog, title: d.querySelector("h2")?.textContent, summary: d.querySelector("[data-import-summary]")?.textContent ?? null,
    groups: [...d.querySelectorAll("[data-import-group]")].map((g) => { const h = g.querySelector(".imp-head input");
      return { kind: g.dataset.importGroup, on: h.checked, mixed: h.indeterminate, items: [...g.querySelectorAll("[data-import-item]")].map((l) => {
        const c = l.querySelector("input"); return { path: l.dataset.importItem, on: c.checked, off: c.disabled, have: !!l.querySelector(".imp-have") }; }) }; }),
    go: d.querySelector("[data-import-go]")?.textContent.trim(), goOff: !!d.querySelector("[data-import-go]")?.disabled,
    copy: d.querySelector("[data-import-copy]")?.checked ?? null, watch: d.querySelector("[data-import-watch]")?.checked ?? null }`);
// listed: its list in (the scanning line's exit finishes before the list comes in)
const found = () => waitFor(async () => (await dialog())?.summary != null, 10000);
const gone = () => waitFor(async () => (await dialog()) == null, 4000);

// fixtures: a tiny video / gif / png made by ffmpeg, a Wallpaper Engine scene folder
function vid(p, c = "blue") { cp.spawnSync("ffmpeg", ["-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=c=${c}:s=64x36`, "-frames:v", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", p]); }
function gif(p) { cp.spawnSync("ffmpeg", ["-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=32x32:rate=4:duration=1", p]); }
function pic(p) { cp.spawnSync("ffmpeg", ["-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=green:s=32x18", "-frames:v", "1", p]); }
function scene(d, title) { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, "project.json"), J({ type: "scene", file: "scene.json", title }));
  fs.writeFileSync(path.join(d, "scene.pkg"), Buffer.alloc(16)); pic(path.join(d, "preview.jpg")); }

app.whenReady().then(async () => {
  setTimeout(() => { console.log("FAIL  the probe ran past 15 minutes"); app.exit(1); }, 15 * 60 * 1000).unref?.();
  win = new BrowserWindow({ show: true, width: 1400, height: 900, webPreferences: { backgroundThrottling: false } });
  win.focus();
  const results = [];
  const cell = async (name, fn) => {
    if (ONLY && !ONLY.test(name)) return;
    let v;
    try { v = await fn(); } catch (e) { v = [`ERROR ${e.message}`]; }
    results.push({ name, v });
    console.log(`${v.length ? "FAIL" : "PASS"}  ${name}`);
    for (const x of v) console.log(`        - ${x}`);
  };
  const T = fs.mkdtempSync(path.join(path.dirname(E.LIASCAPE_BACKEND_LOG), "import-")); // inside the stack's dir: its cleanup takes it
  // a folder per cell (the library remembers what it imported): `n` = its name, the six-item tree the summary names
  let seq = 0;
  const tree = (n) => {
    const d = path.join(T, `${n}-${++seq}`); fs.mkdirSync(path.join(d, "sub"), { recursive: true });
    vid(path.join(d, `${n}a.mp4`)); vid(path.join(d, "sub", `${n}b.mp4`)); gif(path.join(d, `${n}c.gif`)); pic(path.join(d, `${n}d.png`));
    scene(path.join(d, `${n}scene`), `${n} Scene`); vid(path.join(d, `${n}have.mp4`));
    return d;
  };
  const summary = "2 videos, 1 GIF, 1 picture, 1 scene, 1 already in your library";
  try {
    await setSettings({ SettingsLevel: "standard", Morphs: true, Glows: true, AllowScenes: true, CopyFilesInsteadOfSymlinking: false, LiveWallpaperBehindAllTabs: false });
    await load(); // a page first: the debugger (reduced motion) needs one

    for (const mode of ["on", "off", "reduced"]) {
      await cell(`import:button:${mode} — Import → a folder: the dialog lists it by kind, ticked; Import lands the ticked ones`, async () => {
        const v = [];
        const d = tree(`b${mode}`);
        await http("POST", "/library/import", { path: path.join(d, `b${mode}have.mp4`), title: `b${mode}have` });
        await setSettings({ Morphs: mode !== "off" }); await reducedMotion(mode === "reduced"); await load();
        const noMotion = () => js(`return document.documentElement.classList.contains("no-motion")`);
        if (!(await waitFor(async () => (await noMotion()) === (mode !== "on"), 5000))) return [`:root.no-motion is ${await noMotion()} under motion ${mode} — proved nothing`];
        await stubPicker(d);
        const fr = (await js(`const s = ${SAMPLE({ modal: ".imp-modal" }, 700)}; document.querySelector("[data-import-btn]").click(); return await s`)).modal;
        if (mode === "on") {
          const sizes = fr.filter((f) => f[1] != null).map((f) => f[4]);
          if (!(sizes.length > 2 && Math.min(...sizes) < Math.max(...sizes) - 2)) v.push(`motion on: the dialog didn't zoom in (widths ${J([...new Set(sizes)].slice(0, 8))})`);
        } else v.push(...judge("the dialog", fr, { appear: true, size: false }));
        console.log(`        (dialog appear: ${brief(fr)})`);
        if (!(await found())) return [...v, `the dialog never listed the folder: ${J(await dialog())}`];
        const s = await dialog();
        if (s.summary !== summary) v.push(`summary ${J(s.summary)}, want ${J(summary)}`);
        if (J(s.groups.map((g) => [g.kind, g.items.length])) !== J([["video", 3], ["gif", 1], ["image", 1], ["scene", 1]]))
          v.push(`groups ${J(s.groups.map((g) => [g.kind, g.items.length]))}`);
        const all = s.groups.flatMap((g) => g.items);
        const have = all.filter((i) => i.have);
        if (have.length !== 1 || have[0].on || !have[0].off || !have[0].path.endsWith("have.mp4")) v.push(`the library's own: ${J(have)}, want one, unticked and disabled`);
        if (all.some((i) => !i.have && (!i.on || i.off))) v.push(`a new item isn't ticked: ${J(all.filter((i) => !i.have && !i.on))}`);
        if (s.go !== "Import 5" || s.copy !== false) v.push(`button ${J(s.go)}, copy ${s.copy}: want "Import 5", linking`);
        // untick the gif: its group's tick goes off, the videos' stays on; untick one video: that group goes mixed
        await js(`document.querySelector('[data-import-item$="c.gif"] input').click();
          document.querySelector('[data-import-item$="sub/b${mode}b.mp4"] input').click(); return true`);
        await sleep(150);
        const s2 = await dialog();
        const vg = s2.groups.find((g) => g.kind === "video"), gg = s2.groups.find((g) => g.kind === "gif");
        if (!vg.mixed || vg.on || gg.on || gg.mixed) v.push(`group ticks after unticking: videos ${J([vg.on, vg.mixed])} (want mixed), gif ${J([gg.on, gg.mixed])} (want off)`);
        if (s2.go !== "Import 3") v.push(`button ${J(s2.go)}, want "Import 3"`);
        await shot(`dialog-${mode}`, ".imp-modal");
        const before = await titles();
        await js(`document.querySelector("[data-import-go]").click(); return true`);
        if (!(await gone())) v.push("the dialog stayed after Import");
        const want = [`b${mode}a`, `b${mode}d`, `b${mode} Scene`];
        if (!(await waitFor(async () => { const t = await titles(); return want.every((w) => t.includes(w)); }, 20000))) {
          const t = await titles(); v.push(`not landed: ${J(want.filter((w) => !t.includes(w)))}`);
        }
        await sleep(800);
        const added = (await titles()).filter((t) => !before.includes(t)).sort();
        if (J(added) !== J([...want].sort())) v.push(`landed ${J(added)}, want exactly ${J([...want].sort())}`);
        const item = (await library()).find((i) => i.title === `b${mode}a`);
        if (item && !fs.lstatSync(item.videoPath).isSymbolicLink()) v.push(`${item.videoPath} isn't a link (linking was chosen)`);
        if (!(await waitFor(() => js(`return !!document.querySelector('.card [data-title="b${mode}a"], [data-title="b${mode}a"]')`), 8000)))
          v.push("the imported item has no card in the Library");
        await reducedMotion(false);
        return v;
      });
    }

    await cell("import:cancel — Cancel, Escape and a click outside land nothing", async () => {
      const v = [];
      await setSettings({ Morphs: true }); await load();
      const d = tree("x");
      const before = (await titles()).length;
      for (const how of ["cancel", "escape", "outside"]) {
        await stubPicker(d);
        await js(`document.querySelector("[data-import-btn]").click(); return true`);
        if (!(await found())) { v.push(`${how}: the dialog didn't list the folder`); continue; }
        if (how === "cancel") await js(`[...document.querySelectorAll(".imp-actions .btn")].find((b) => b.textContent.trim() === "Cancel").click(); return true`);
        else if (how === "escape") win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
        else await js(`document.querySelector(".modal-backdrop").dispatchEvent(new MouseEvent("click", { bubbles: true })); return true`);
        if (!(await gone())) v.push(`${how}: the dialog stayed`);
      }
      await sleep(1500);
      if ((await titles()).length !== before) v.push(`something landed: ${(await titles()).length - before} item(s)`);
      return v;
    });

    // the picked files in the dialog: just them, no folder watch offered; then Cancel
    const filesListed = async (files) => {
      if (!(await found())) return ["the dialog didn't list the picked files"];
      const v = [];
      const s = await dialog();
      const paths = s.groups.flatMap((g) => g.items.map((i) => i.path)).sort();
      if (J(paths) !== J([...files].sort())) v.push(`listed ${J(paths)}, want just ${J(files)}`);
      if (s.summary !== "1 video, 1 GIF") v.push(`summary ${J(s.summary)}`);
      if (s.watch !== null) v.push("files offered a folder watch");
      await js(`[...document.querySelectorAll(".imp-actions .btn")].find((b) => b.textContent.trim() === "Cancel").click(); return true`);
      await gone();
      return v;
    };
    const menuItems = () => js(`return [...document.querySelectorAll(".ctx-pop [data-ctx-item]")].map((b) => b.textContent.trim())`);
    const menuOpen = () => js(`return !!document.querySelector(".ctx-pop:not(.closing)")`);

    for (const mode of ["on", "off", "reduced"]) {
      await cell(`import:files:${mode} — the Import's chevron, in sight: its menu (the chevron turns) has Import files…, which opens the dialog on just them`, async () => {
        const v = [];
        await setSettings({ Morphs: mode !== "off" }); await reducedMotion(mode === "reduced"); await load();
        const noMotion = () => js(`return document.documentElement.classList.contains("no-motion")`);
        if (!(await waitFor(async () => (await noMotion()) === (mode !== "on"), 5000))) return [`:root.no-motion is ${await noMotion()} under motion ${mode} — proved nothing`];
        const d = tree(`f${mode}`);
        const files = [path.join(d, `f${mode}a.mp4`), path.join(d, `f${mode}c.gif`)];
        await stubPicker(d, files);
        // in sight: a real box right beside Import, its height, inside the top bar, with its own name and a menu popup
        const g = await js(`const m = document.querySelector("[data-import-more]"), b = document.querySelector("[data-import-btn]"), t = document.querySelector(".topbar");
          if (!m) return null; const r = m.getBoundingClientRect(), rb = b.getBoundingClientRect(), rt = t.getBoundingClientRect(), cs = getComputedStyle(m);
          return { w: r.width, h: r.height, bh: rb.height, adj: Math.abs(r.left - rb.right) < 1.5, inBar: r.top >= rt.top && r.bottom <= rt.bottom,
            vis: cs.visibility === "visible" && +cs.opacity > 0.9, label: m.getAttribute("aria-label"), pop: m.getAttribute("aria-haspopup"), exp: m.getAttribute("aria-expanded") }`);
        if (!g) return ["no chevron beside Import"];
        if (!(g.w >= 20 && g.h === g.bh && g.adj && g.inBar && g.vis)) v.push(`the chevron isn't a visible half of the Import button: ${J(g)}`);
        if (!g.label || g.pop !== "menu" || g.exp !== "false") v.push(`chevron aria: ${J(g)}`);
        if (mode === "on") await shot("split", "[data-import-split]");
        // opened by a click: the caret's turn and the menu's appearance, frame by frame
        const fr = await js(`const caret = document.querySelector("[data-import-more] .sel-caret"), turns = [];
          const t0 = performance.now(); const tick = () => { turns.push(getComputedStyle(caret).transform); if (performance.now() - t0 < 700) requestAnimationFrame(tick); };
          const s = ${SAMPLE({ menu: ".ctx-pop" }, 700)}; requestAnimationFrame(tick); document.querySelector("[data-import-more]").click();
          const out = await s; await new Promise((r) => setTimeout(r, 50)); return { menu: out.menu, turns }`);
        const turns = [...new Set(fr.turns)];
        if (mode === "on") {
          if (turns.length < 4) v.push(`motion on: the chevron didn't turn through in-between angles (${J(turns.slice(0, 6))})`);
          const ws = fr.menu.filter((f) => f[1] != null).map((f) => f[4]);
          if (!(ws.length > 2 && Math.min(...ws) < Math.max(...ws) - 2)) v.push(`motion on: the menu didn't grow in (${brief(fr.menu)})`);
        } else {
          if (turns.length > 2) v.push(`motion ${mode}: the chevron turned through ${turns.length} angles, want it to flip at once`);
          v.push(...judge("the menu", fr.menu, { appear: true }));
        }
        if (!/^matrix\(-1, /.test(turns.at(-1) ?? "")) v.push(`the open menu's chevron isn't turned over (${turns.at(-1)})`);
        if ((await js(`return document.querySelector("[data-import-more]").getAttribute("aria-expanded")`)) !== "true") v.push("aria-expanded isn't true while open");
        if (J(await menuItems()) !== J(["Import a folder…", "Import files…", "Import from a link…"])) v.push(`menu ${J(await menuItems())}`);
        // it hangs under the pair, flush with one of its edges (never beside it)
        const at = await js(`const p = document.querySelector(".ctx-pop").getBoundingClientRect(), s = document.querySelector("[data-import-split]").getBoundingClientRect();
          return { below: p.top >= s.bottom, flush: Math.min(Math.abs(p.left - s.left), Math.abs(p.right - s.right)) < 1.5, p: [p.left, p.right], s: [s.left, s.right] }`);
        if (!at.below || !at.flush) v.push(`the menu isn't under the Import pair, flush with an edge: ${J(at)}`);
        if (mode === "on") await shot("menu");
        await js(`document.querySelector('.ctx-pop [data-ctx-item="files"]').click(); return true`);
        v.push(...await filesListed(files));
        await reducedMotion(false);
        return v;
      });
    }

    await cell("import:files:keys — the chevron by keyboard: ↓ opens its menu on the first entry, Escape gives focus back, Enter ↓ Enter picks files", async () => {
      const v = [];
      await setSettings({ Morphs: true }); await load();
      const d = tree("k");
      const files = [path.join(d, "ka.mp4"), path.join(d, "kc.gif")];
      await stubPicker(d, files);
      // Enter presses a button on its char event, as a real key does
      const key = (k) => { win.webContents.sendInputEvent({ type: "keyDown", keyCode: k });
        if (k === "Return") win.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
        win.webContents.sendInputEvent({ type: "keyUp", keyCode: k }); };
      const focused = () => js(`const a = document.activeElement; return a?.dataset.ctxItem ?? (a?.hasAttribute("data-import-more") ? "chevron" : a?.tagName)`);
      win.webContents.focus();
      await js(`document.querySelector("[data-import-more]").focus(); return true`);
      key("Down");
      if (!(await waitFor(menuOpen, 2000))) return ["↓ on the chevron didn't open its menu"];
      await sleep(150);
      if ((await focused()) !== "folder") v.push(`first focus ${J(await focused())}, want the folder entry`);
      key("Escape");
      if (!(await waitFor(async () => !(await menuOpen()), 2000))) v.push("Escape didn't close the menu");
      if ((await focused()) !== "chevron") v.push(`after Escape the focus is on ${J(await focused())}, want the chevron`);
      key("Return");
      if (!(await waitFor(menuOpen, 2000))) return [...v, "Enter on the chevron didn't open its menu"];
      await sleep(150);
      if (await dialog()) return [...v, "Enter on the chevron also picked the menu's first entry"];
      if ((await focused()) !== "folder") v.push(`after Enter the focus is on ${J(await focused())}, want the folder entry`);
      key("Down");
      await sleep(100);
      if ((await focused()) !== "files") v.push(`↓ moved the focus to ${J(await focused())}, want the files entry`);
      key("Return");
      v.push(...await filesListed(files));
      return v;
    });

    await cell("import:files:rightClick — a right-click on Import opens the same menu at the pointer; a click on Import still picks a folder", async () => {
      const v = [];
      await load();
      const d = tree("r");
      await stubPicker(d, [path.join(d, "ra.mp4")]);
      const r = await js(`const b = document.querySelector("[data-import-btn]").getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }`);
      win.webContents.sendInputEvent({ type: "mouseDown", x: Math.round(r.x), y: Math.round(r.y), button: "right", clickCount: 1 });
      win.webContents.sendInputEvent({ type: "mouseUp", x: Math.round(r.x), y: Math.round(r.y), button: "right", clickCount: 1 });
      if (!(await waitFor(menuOpen, 3000))) return ["no menu on the Import's right-click"];
      if (J(await menuItems()) !== J(["Import a folder…", "Import files…", "Import from a link…"])) v.push(`menu ${J(await menuItems())}`);
      win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
      await waitFor(async () => !(await menuOpen()), 2000);
      await js(`document.querySelector("[data-import-btn]").click(); return true`);
      if (!(await found())) return [...v, "a click on Import didn't open the dialog on the picked folder"];
      if ((await dialog()).groups.flatMap((g) => g.items).length !== 6) v.push("a click on Import didn't list the folder's six items");
      await js(`[...document.querySelectorAll(".imp-actions .btn")].find((b) => b.textContent.trim() === "Cancel").click(); return true`);
      await gone();
      return v;
    });

    for (const mode of ["on", "off"]) {
      await cell(`import:drop:${mode} — files dragged over the window show the drop frame; a drop opens the dialog on them`, async () => {
        const v = [];
        await setSettings({ Morphs: mode === "on" }); await load();
        const d = tree(`d${mode}`);
        const uri = "file://" + encodeURI(d);
        const ev = (type) => `{ const dt = new DataTransfer(); dt.setData("text/uri-list", ${J(uri)});
          document.querySelector(".grid, .scroll, body").dispatchEvent(new DragEvent(${J(type)}, { dataTransfer: dt, bubbles: true, cancelable: true })); }`;
        const fire = (type) => js(`${ev(type)} return true`);
        const fr = (await js(`const s = ${SAMPLE({ frame: "[data-import-drop]" }, 600)}; ${ev("dragenter")} ${ev("dragover")} return await s`)).frame;
        if (mode === "on") {
          const ws = fr.filter((f) => f[1] != null).map((f) => f[4]);
          if (!(ws.length > 2 && Math.min(...ws) < Math.max(...ws) - 2)) v.push(`motion on: the frame didn't scale in (${brief(fr)})`);
        } else v.push(...judge("the drop frame", fr, { appear: true }));
        await shot(`drop-${mode}`);
        await fire("dragleave");
        if (!(await waitFor(() => js(`return !document.querySelector("[data-import-drop]")`), 2000))) v.push("leaving the window kept the frame");
        await fire("dragenter"); await fire("drop");
        if (!(await waitFor(() => js(`return !document.querySelector("[data-import-drop]")`), 2000))) v.push("the frame stayed after the drop");
        if (!(await found())) return [...v, "a drop didn't open the dialog on the folder"];
        const s = await dialog();
        if (s.groups.flatMap((g) => g.items).length !== 6) v.push(`the dropped folder listed ${s.groups.flatMap((g) => g.items).length} items, want 6`);
        if (s.watch !== false) v.push(`a dropped folder: "Keep watching" ${s.watch}, want offered and off`);
        await js(`[...document.querySelectorAll(".imp-actions .btn")].find((b) => b.textContent.trim() === "Cancel").click(); return true`);
        await gone();
        return v;
      });
    }

    await cell("import:settings — Add folder watches it: listed with its count and copy choice, live pickup, remove keeps the items", async () => {
      const v = [];
      await setSettings({ Morphs: true }); await load();
      const d = tree("w");
      await js(`[...document.querySelectorAll(".tab")].find((t) => t.textContent.trim() === "Settings").click(); return true`);
      if (!(await waitFor(() => js(`return !!document.querySelector("[data-watched-add]")`), 8000))) return ["no \"Add folder\" in Settings"];
      await stubPicker(d);
      await js(`const b = document.querySelector("[data-watched-add]"); b.scrollIntoView({ block: "center" }); b.click(); return true`);
      if (!(await found())) return ["Add folder didn't open the dialog on the folder"];
      const s = await dialog();
      if (s.title !== "Watch a folder" || s.watch !== true) v.push(`title ${J(s.title)}, keep watching ${s.watch}: want "Watch a folder", ticked`);
      await js(`document.querySelector("[data-import-go]").click(); return true`);
      await gone();
      const row = () => js(`const r = document.querySelector('[data-watched="${d}"]'); return r && { hint: r.querySelector(".shint")?.textContent, copy: r.querySelector("[data-watched-copy]")?.checked }`);
      if (!(await waitFor(async () => (await row())?.hint === "6 wallpapers", 20000))) v.push(`the row: ${J(await row())}, want "6 wallpapers"`);
      await shot("settings", ".ssection:has([data-watched-add])");
      await js(`document.querySelector('[data-watched="${d}"] [data-watched-copy]').click(); return true`);
      const copyOf = async () => ((await http("GET", "/settings")).json?.watchedFolders ?? []).find((w) => w.path === d)?.copy;
      if (!(await waitFor(async () => (await copyOf()) === true, 8000))) v.push(`its copy choice didn't save (${await copyOf()})`);
      // live: a file written into the folder shows up in the Library without a click
      vid(path.join(d, "wlive.mp4"));
      await js(`[...document.querySelectorAll(".tab")].find((t) => t.textContent.trim() === "Library").click(); return true`);
      if (!(await waitFor(() => js(`return !!document.querySelector('[data-title="wlive"]')`), 20000))) v.push("a new file in the watched folder never showed up in the Library");
      else if (fs.lstatSync(((await library()).find((i) => i.title === "wlive") ?? {}).videoPath ?? d).isSymbolicLink()) v.push("the new file came in as a link after Copy was chosen");
      await js(`[...document.querySelectorAll(".tab")].find((t) => t.textContent.trim() === "Settings").click(); return true`);
      await waitFor(() => js(`return !!document.querySelector('[data-watched="${d}"]')`), 5000);
      await sleep(1000); // the page's own fade-in after the tab switch
      // the section in view, as a hand reaching for the remove button has it: the rows are framer layout nodes only on screen
      // (views/Settings.tsx), so the row leaves through that path
      await js(`document.querySelector("[data-watched-add]").scrollIntoView({ block: "center" }); return true`); await sleep(600);
      // "Add folder"'s y before the click, then a sample per frame once the page has handled it (a task later: React commits
      // and framer asks for its frame in microtasks, so the sampler's frame callback runs after framer's and reads the glide's
      // transform as painted), and a picture mid-way (the row half faded, "Add folder" on its way up): import-settings-remove-<m>.png
      // `next` = the section below the card: every section under it moves with the card's bottom edge
      const NEXT = ".ssection:has([data-watched-add]) ~ *";
      const remove = async (dir, m) => {
        const s = js(`const y0 = +document.querySelector("[data-watched-add]").getBoundingClientRect().y.toFixed(1);
          const ny0 = +document.querySelector(${J(NEXT)}).getBoundingClientRect().y.toFixed(1);
          document.querySelector('[data-watched="${dir}"] [data-watched-remove]').click();
          await new Promise((r) => setTimeout(r));
          return { y0, ny0, ...(await ${SAMPLE({ row: `[data-watched="${dir}"]`, add: "[data-watched-add]", card: ".ssection:has([data-watched-add])", next: NEXT }, 700)}) }`);
        await sleep(80);
        fs.writeFileSync(path.join(OUT, `import-settings-remove-${m}.png`), (await win.webContents.capturePage()).toPNG());
        return s;
      };
      // "Add folder"'s way up: where it started and ended, the frames it spent in between (more than a pixel from both) and
      // whether it ever went back down
      const travel = (fr) => { const ys = fr.add.filter((f) => f[1] != null).map((f) => f[3]);
        const y0 = fr.y0, y1 = ys[ys.length - 1];
        return { y0, y1, mid: ys.filter((y) => y < y0 - 1 && y > y1 + 1).length, back: ys.some((y, i) => y > (i ? ys[i - 1] : y0) + 1),
          ys: ys.filter((y, i) => !i || y !== ys[i - 1]).slice(0, 16).join(" ") }; };
      // the next section's way (up on a remove, down on an add): the frames it spent more than a pixel from both ends, and
      // whether it ever turned back
      const slide = (fr, y0) => { const ys = fr.next.filter((f) => f[1] != null).map((f) => f[3]);
        const y1 = ys[ys.length - 1], dn = y1 > y0;
        return { y0, y1, moved: Math.abs(y1 - y0) > 10, mid: ys.filter((y) => y > Math.min(y0, y1) + 1 && y < Math.max(y0, y1) - 1).length,
          back: ys.some((y, i) => (dn ? -1 : 1) * (y - (i ? ys[i - 1] : y0)) > 1), ys: ys.filter((y, i) => !i || y !== ys[i - 1]).slice(0, 16).join(" ") }; };
      const fr = await remove(d, "on");
      const fades = fr.row.filter((f) => f[1] != null && f[1] > 0.02 && f[1] < 0.95).length;
      if (!fades) v.push(`the row popped out (${brief(fr.row)})`);
      const xs = fr.row.filter((f) => f[1] != null).map((f) => f[2]);
      if (xs.length && Math.max(...xs) - Math.min(...xs) > 1) v.push(`motion on: the leaving row moved sideways (x ${Math.min(...xs)}..${Math.max(...xs)})`);
      const on = travel(fr);
      if (!(on.y1 < on.y0 - 10)) v.push(`motion on: "Add folder" didn't move up (y ${on.y0} → ${on.y1}) — proved nothing`);
      else if (on.mid < 3) v.push(`motion on: "Add folder" jumped up instead of gliding (${on.mid} in-between frames, y ${on.y0} → ${on.ys})`);
      else if (on.back) v.push(`motion on: "Add folder" went back down on its way up (y ${on.y0} → ${on.ys})`);
      const clipped = fr.add.map((f, i) => [f, fr.card[i]]).filter(([a, c]) => a[1] != null && c?.[1] != null && a[3] + a[5] > c[3] + c[5] - 1);
      if (clipped.length) v.push(`motion on: "Add folder" ran past the card's bottom edge (clipped) in ${clipped.length} frames (${J(clipped[0])})`);
      const nx = slide(fr, fr.ny0);
      if (!nx.moved) v.push(`motion on: the section below didn't move up (y ${nx.y0} → ${nx.y1}) — proved nothing`);
      else if (nx.mid < 3) v.push(`motion on: the section below jumped up instead of gliding (${nx.mid} in-between frames, y ${nx.y0} → ${nx.ys})`);
      else if (nx.back) v.push(`motion on: the section below went back down on its way up (y ${nx.y0} → ${nx.ys})`);
      if (!(await waitFor(async () => !((await http("GET", "/settings")).json?.watchedFolders ?? []).some((w) => w.path === d), 8000))) v.push("remove didn't stop the watching");
      // an add (the backend's settings-changed, as the import dialog's Import brings it): the card grows through in-between
      // frames, the section below glides down with it, "Add folder" never clipped by the card on its way down
      const d3 = tree("wn");
      const ny0 = await js(`return +document.querySelector(${J(NEXT)}).getBoundingClientRect().y.toFixed(1)`);
      const sampling = js(`return await ${SAMPLE({ add: "[data-watched-add]", card: ".ssection:has([data-watched-add])", next: NEXT }, 1500)}`);
      await sleep(100);
      if ((await http("POST", "/library/watched", { path: d3 })).status !== 200) v.push("couldn't watch a folder through the API");
      await sleep(150);
      fs.writeFileSync(path.join(OUT, "import-settings-add-on.png"), (await win.webContents.capturePage()).toPNG());
      const fa = await sampling;
      const na = slide(fa, ny0);
      if (!na.moved) v.push(`motion on, add: the section below didn't move down (y ${na.y0} → ${na.y1}) — proved nothing`);
      else if (na.mid < 3) v.push(`motion on, add: the section below jumped down instead of gliding (${na.mid} in-between frames, y ${na.y0} → ${na.ys})`);
      else if (na.back) v.push(`motion on, add: the section below went back up on its way down (y ${na.y0} → ${na.ys})`);
      const clippedA = fa.add.map((f, i) => [f, fa.card[i]]).filter(([a, c]) => a[1] != null && c?.[1] != null && a[3] + a[5] > c[3] + c[5] - 1);
      if (clippedA.length) v.push(`motion on, add: "Add folder" ran past the card's bottom edge (clipped) in ${clippedA.length} frames (${J(clippedA[0])})`);
      await http("POST", "/library/watched", { path: d3, remove: true });
      if (!(await titles()).includes("wa")) v.push("removing the folder took its wallpapers away");
      // motion off: the row fades in place, then "Add folder" takes its place at once
      const d2 = tree("wo");
      await setSettings({ Morphs: false });
      if ((await http("POST", "/library/watched", { path: d2 })).status !== 200) return [...v, "couldn't watch a second folder"];
      await load();
      await js(`[...document.querySelectorAll(".tab")].find((t) => t.textContent.trim() === "Settings").click(); return true`);
      if (!(await waitFor(() => js(`return !!document.querySelector('[data-watched="${d2}"]')`), 8000))) return [...v, "motion off: the second folder isn't listed"];
      await sleep(1000);
      await js(`document.querySelector("[data-watched-add]").scrollIntoView({ block: "center" }); return true`); await sleep(600);
      const fo = await remove(d2, "off");
      v.push(...judge("motion off: the leaving row", fo.row, { leave: true }));
      const off = travel(fo);
      if (!(off.y1 < off.y0 - 10)) v.push(`motion off: "Add folder" didn't move up (y ${off.y0} → ${off.y1}) — proved nothing`);
      else if (off.mid) v.push(`motion off: "Add folder" moved through ${off.mid} in-between frames (y ${off.y0} → ${off.ys}), want a jump`);
      const noff = slide(fo, fo.ny0);
      if (!noff.moved) v.push(`motion off: the section below didn't move up (y ${noff.y0} → ${noff.y1}) — proved nothing`);
      else if (noff.mid) v.push(`motion off: the section below moved through ${noff.mid} in-between frames (y ${noff.y0} → ${noff.ys}), want a jump`);
      await setSettings({ Morphs: true });
      return v;
    });

    await cell("import:steam — Steam's own Workshop folder: its items apart as your Steam subscriptions, disabled, saying how they come in", async () => {
      const v = [];
      // a second Steam library, named only in Steam's libraryfolders.vdf (the backend reads it from this HOME at each scan)
      const lib = path.join(T, "steamlib"), wc = path.join(lib, "steamapps", "workshop", "content", "431960");
      const vdfDir = path.join(E.HOME, ".local", "share", "Steam", "steamapps");
      fs.mkdirSync(vdfDir, { recursive: true });
      fs.writeFileSync(path.join(vdfDir, "libraryfolders.vdf"), `"libraryfolders"\n{\n\t"1"\n\t{\n\t\t"path"\t\t"${lib}"\n\t}\n}\n`);
      scene(path.join(wc, "7100000001"), "Steam Sub Scene"); scene(path.join(wc, "7100000002"), "Steam Sub Two");
      vid(path.join(lib, "smine.mp4"));
      const look = async (autoImport) => {
        await setSettings({ AutoAddWeWallpapersToLibrary: autoImport }); await load();
        await stubPicker(lib);
        await js(`document.querySelector("[data-import-btn]").click(); return true`);
        if (!(await found())) return [`auto-import ${autoImport}: the dialog didn't list the folder`];
        const w = [];
        const s = await dialog();
        if (s.summary !== "1 video, 2 from your Steam subscriptions") w.push(`summary ${J(s.summary)}`);
        if (J(s.groups.map((g) => g.kind)) !== J(["video", "steam"])) w.push(`groups ${J(s.groups.map((g) => g.kind))}, want the subscriptions last, apart`);
        const sg = s.groups.find((g) => g.kind === "steam");
        if (sg) {
          const head = await js(`const g = document.querySelector('[data-import-group="steam"]'); const h = g.querySelector(".imp-head");
            return { label: h.querySelector(".imp-gname")?.textContent, off: h.querySelector("input").disabled, why: g.querySelector("[data-import-steam-why]")?.textContent ?? null }`);
          if (head.label !== "From your Steam subscriptions") w.push(`group label ${J(head.label)}`);
          if (!head.off || sg.on || sg.mixed) w.push(`the group's tick: disabled ${head.off}, on ${sg.on}, mixed ${sg.mixed} (want disabled, off)`);
          if (sg.items.length !== 2 || sg.items.some((i) => i.on || !i.off)) w.push(`its items ${J(sg.items)}: want two, unticked and disabled`);
          const want = autoImport ? /Import new Workshop wallpapers brings these/ : /turn on Import new Workshop wallpapers in Settings/;
          if (!want.test(head.why ?? "")) w.push(`auto-import ${autoImport}: its line ${J(head.why)}`);
        }
        const own = s.groups.find((g) => g.kind === "video")?.items ?? [];
        if (own.length !== 1 || !own[0].on || own[0].off) w.push(`the user's own file: ${J(own)}, want ticked`);
        if (s.go !== "Import 1") w.push(`button ${J(s.go)}, want "Import 1"`);
        return w.map((x) => `auto-import ${autoImport}: ${x}`);
      };
      v.push(...await look(true));
      await js(`[...document.querySelectorAll(".imp-actions .btn")].find((b) => b.textContent.trim() === "Cancel").click(); return true`);
      await gone();
      v.push(...await look(false));
      const col = await js(`const cs = (s) => { const e = document.querySelector(s); return e ? getComputedStyle(e) : null; };
        const probe = document.createElement("i"); document.body.append(probe);
        const tv = (n) => { probe.style.color = "var(" + n + ")"; return getComputedStyle(probe).color; };
        const out = { why: cs("[data-import-steam-why]")?.color, subtext: tv("--subtext"), gico: cs('[data-import-group="steam"] .imp-gico')?.color, accent: tv("--accent") };
        probe.remove(); return out;`);
      if (col.why !== col.subtext) v.push(`its line ${col.why}, want --subtext ${col.subtext}`);
      if (col.gico !== col.accent) v.push(`its chip ${col.gico}, want --accent ${col.accent}`);
      await shot("steam", ".imp-modal");
      await js(`document.documentElement.classList.add("no-glow", "bg-live"); return true`); await sleep(200);
      const fill = await js(`return getComputedStyle(document.querySelector(".imp-modal")).backgroundColor`);
      if (/rgba\(0, 0, 0, 0\)|transparent/.test(fill)) v.push(`bg-live: the dialog lost its fill (${fill})`);
      await shot("steam-noglow-bglive", ".imp-modal");
      await js(`document.documentElement.classList.remove("no-glow", "bg-live"); return true`);
      const before = await titles();
      await js(`document.querySelector("[data-import-go]").click(); return true`);
      if (!(await gone())) v.push("the dialog stayed after Import");
      if (!(await waitFor(async () => (await titles()).includes("smine"), 20000))) v.push("the user's own file never landed");
      await sleep(800);
      const added = (await titles()).filter((t) => !before.includes(t));
      if (J(added) !== J(["smine"])) v.push(`landed ${J(added)}, want only "smine"`);
      const linked = (await library()).filter((i) => { try { return fs.realpathSync(i.videoPath).startsWith(wc + "/"); } catch { return false; } });
      if (linked.length) v.push(`the library links into Steam's folder: ${J(linked.map((i) => i.videoPath))}`);
      fs.rmSync(path.join(vdfDir, "libraryfolders.vdf"), { force: true });
      return v;
    });

    // ---- an import from a link ----
    // this probe's own file server on loopback (the stack's backend lets a link reach it: LIASCAPE_TEST_LINK_LOOPBACK): any
    // /files/<name>.mp4 is one small video, /slow/<name>.mp4 the same sent in pieces over ~2.5 s (a progress bar to see),
    // /page a web page, /fake.mp4 a page served as video/mp4
    const srcVid = path.join(T, "served.mp4"); vid(srcVid, "purple");
    const served = fs.readFileSync(srcVid);
    let fakeAsked = 0; // how often /fake.mp4 was asked for (import:link:error tries it twice)
    const server = require("http").createServer((req, res) => {
      const p = req.url.split("?")[0];
      if (p.startsWith("/files/")) { res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": served.length }); res.end(served); }
      else if (p.startsWith("/slow/")) {
        res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": served.length });
        const n = 12, step = Math.ceil(served.length / n);
        let i = 0;
        const t = setInterval(() => { res.write(served.subarray(i * step, (i + 1) * step)); if (++i >= n) { clearInterval(t); res.end(); } }, 210);
        req.on("close", () => clearInterval(t));
      } else if (p === "/page") { res.writeHead(200, { "Content-Type": "text/html" }); res.end("<!doctype html><title>a page</title>"); }
      else if (p === "/fake.mp4") { fakeAsked++; res.writeHead(200, { "Content-Type": "video/mp4" }); res.end("<!doctype html><title>log in</title>" + " ".repeat(64)); }
      else { res.writeHead(404); res.end(); }
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const S = `http://127.0.0.1:${server.address().port}`;
    const linkState = () => js(`const d = document.querySelector("[data-import-dialog]"); if (!d) return null; const i = d.querySelector("[data-import-link]");
      const l = d.querySelector("[data-import-link-line]");
      return { state: d.dataset.importDialog, title: d.querySelector("h2")?.textContent, value: i?.value ?? null, focused: !!i && document.activeElement === i,
        inputOff: !!i?.disabled, line: l?.dataset.importLinkLine ?? null, text: l?.textContent.trim() ?? null,
        name: d.querySelector("[data-import-link-title]")?.textContent ?? null, where: d.querySelector("[data-import-link-where]")?.textContent ?? null,
        have: !!d.querySelector(".imp-link-row .imp-have"), failed: d.querySelector("[data-import-link-failed]")?.textContent ?? null, progress: !!d.querySelector("[data-import-link-progress]"),
        go: d.querySelector("[data-import-go]")?.textContent.trim(), goOff: !!d.querySelector("[data-import-go]")?.disabled,
        cancel: [...d.querySelectorAll(".imp-actions .btn.ghost")].map((b) => b.textContent.trim()).find((t) => t === "Cancel" || t === "Close") }`);
    // typed as a user types: React's own value setter, then the input event
    const setLink = (u) => `{ const i = document.querySelector("[data-import-link]"); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(i, ${J(u)});
      i.dispatchEvent(new Event("input", { bubbles: true })); }`;
    const lineIs = (want, ms = 6000) => waitFor(async () => (await linkState())?.line === want, ms);
    const statusText = () => js(`return document.querySelector('.topbar [data-st="status"]')?.textContent ?? null`);
    const closeDialog = async () => { await js(`[...document.querySelectorAll(".imp-actions .btn.ghost")].find((b) => /^(Cancel|Close)$/.test(b.textContent.trim()))?.click(); return true`); await gone(); };
    const openLinkFromMenu = () => js(`document.querySelector("[data-import-more]").click(); await new Promise((r) => setTimeout(r, 350));
      const e = [...document.querySelectorAll(".ctx-pop [data-ctx-item]")].find((b) => b.textContent.trim() === "Import from a link…"); if (!e) return false; e.click(); return true`);

    for (const mode of ["on", "off", "reduced"]) {
      await cell(`import:link:${mode} — Import from a link…: an unknown site isn't supported; a file's link shows what it is, imports with a progress bar, lands`, async () => {
        const v = [];
        await setSettings({ Morphs: mode !== "off" }); await reducedMotion(mode === "reduced"); await load();
        const noMotion = () => js(`return document.documentElement.classList.contains("no-motion")`);
        if (!(await waitFor(async () => (await noMotion()) === (mode !== "on"), 5000))) return [`:root.no-motion is ${await noMotion()} under motion ${mode} — proved nothing`];
        await js(`document.querySelector("[data-import-more]").click(); return true`);
        if (!(await waitFor(menuOpen, 3000))) return ["the Import menu didn't open"];
        await sleep(350);
        const fr = (await js(`const s = ${SAMPLE({ modal: ".imp-modal" }, 700)};
          [...document.querySelectorAll(".ctx-pop [data-ctx-item]")].find((b) => b.textContent.trim() === "Import from a link…").click(); return await s`)).modal;
        if (mode === "on") {
          const sizes = fr.filter((f) => f[1] != null).map((f) => f[4]);
          if (!(sizes.length > 2 && Math.min(...sizes) < Math.max(...sizes) - 2)) v.push(`motion on: the dialog didn't zoom in (widths ${J([...new Set(sizes)].slice(0, 8))})`);
        } else v.push(...judge("the dialog", fr, { appear: true, size: false }));
        const s0 = await linkState();
        if (!s0 || s0.state !== "link" || s0.title !== "Import from a link") return [...v, `the dialog: ${J(s0)}, want "Import from a link"`];
        if (!s0.focused || s0.value !== "" || !s0.goOff || s0.line != null || s0.cancel !== "Cancel") v.push(`opened: ${J(s0)}, want an empty focused field, no line, Import off`);
        // an unknown site's page: it isn't supported, in plain words
        await js(`${setLink(`${S}/page`)} return true`);
        if (!(await lineIs("error"))) v.push(`an unknown site's page: no error line (${J(await linkState())})`);
        else {
          const s = await linkState();
          if (!/^That site isn't supported\. Import takes a Steam Workshop item, a MoeWalls, DesktopHut or MotionBgs page, or a link straight to a video or picture\.$/.test(s.text)) v.push(`the error line says ${J(s.text)}`);
          if (!s.goOff) v.push("Import is on for an unsupported site");
        }
        // a file's link: what it names, the line rising in (motion off: fading in place)
        const url = `${S}/slow/lk${mode}.mp4`;
        const lf = (await js(`const s = ${SAMPLE({ line: '[data-import-link-line="found"]' }, 1300)}; ${setLink(url)} return await s`)).line;
        if (mode === "on") {
          const mids = lf.filter((f) => f[1] != null && f[1] > 0.02 && f[1] < 0.95).length, ys = new Set(lf.filter((f) => f[1] != null).map((f) => f[3]));
          if (!mids || ys.size < 2) v.push(`motion on: the found line didn't rise in (${brief(lf)})`);
        } else v.push(...judge("the found line", lf, { appear: true }));
        const s1 = await linkState();
        if (s1.line !== "found" || s1.name !== `lk${mode}` || s1.where !== "Video from 127.0.0.1" || s1.goOff || s1.go !== "Import" || s1.have)
          v.push(`a file's link: ${J(s1)}, want lk${mode}, "Video from 127.0.0.1", Import on`);
        await shot(`link-found-${mode}`, ".imp-modal");
        // Import: the progress fades in under it and fills as the file comes, then the dialog leaves
        const before = await titles();
        const pf = js(`const s = ${SAMPLE({ dl: "[data-import-link-progress]", fill: "[data-import-link-progress] .dl-fill" }, 1600)};
          document.querySelector("[data-import-go]").click(); return await s`);
        await sleep(700);
        const mid = await linkState();
        await shot(`link-progress-${mode}`, ".imp-modal");
        const p = await pf;
        if (!mid?.progress || mid.go !== "Importing…" || !mid.goOff || mid.cancel !== "Close" || !mid.inputOff)
          v.push(`while importing: ${J(mid)}, want the progress bar, "Importing…" off, "Close", the field off`);
        if (mode === "on") { if (!p.dl.some((f) => f[1] != null && f[1] > 0.02 && f[1] < 0.95)) v.push(`motion on: the progress popped in (${brief(p.dl)})`); }
        else v.push(...judge("the progress", p.dl, { appear: true }));
        const widths = [...new Set(p.fill.filter((f) => f[1] != null).map((f) => f[4]))];
        if (widths.length < 3) v.push(`the fill didn't fill through in-between widths (${J(widths)})`);
        if (!(await waitFor(async () => (await dialog()) == null, 10000))) v.push("the dialog stayed after the import");
        if (!(await waitFor(async () => (await titles()).includes(`lk${mode}`), 10000))) v.push(`lk${mode} never landed`);
        const added = (await titles()).filter((t) => !before.includes(t));
        if (J(added) !== J([`lk${mode}`])) v.push(`landed ${J(added)}, want just lk${mode}`);
        if (!(await waitFor(() => js(`return !!document.querySelector('[data-title="lk${mode}"]')`), 8000))) v.push("the imported item has no card");
        if (!(await waitFor(async () => (await statusText()) === `Imported: lk${mode}`, 4000))) v.push(`the status line says ${J(await statusText())}`);
        const it = (await library()).find((i) => i.title === `lk${mode}`);
        if (it && it.sourceId !== url) v.push(`its source ${J(it.sourceId)}, want the link`);
        await reducedMotion(false);
        return v;
      });
    }

    await cell("import:link:paste — a link pasted on the Library opens the dialog on it; other pastes open nothing", async () => {
      const v = [];
      await setSettings({ Morphs: true }); await load();
      const paste = (text, on = "document.body") => js(`document.activeElement?.blur?.(); const dt = new DataTransfer(); dt.setData("text/plain", ${J(text)});
        const t = ${on}; if (!t) return false; t.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); return true`);
      const url = `${S}/files/pasted.mp4`;
      await paste(url);
      if (!(await waitFor(async () => (await linkState())?.state === "link", 3000))) return ["a pasted link didn't open the dialog"];
      if (!(await lineIs("found", 3000))) v.push(`the pasted link wasn't resolved at once: ${J(await linkState())}`);
      const s = await linkState();
      if (s.value !== url || s.name !== "pasted") v.push(`the dialog on ${J(s.value)} naming ${J(s.name)}, want the pasted link`);
      await closeDialog();
      await paste("just some words"); await sleep(500);
      if (await dialog()) { v.push("plain text opened the dialog"); await closeDialog(); }
      // a paste in a text field is that field's
      const inField = await paste(url, `document.querySelector(".topbar input")`);
      await sleep(500);
      if (!inField) v.push("no text field in the top bar to paste into — proved nothing for it");
      else if (await dialog()) { v.push("a paste in the search field opened the dialog"); await closeDialog(); }
      await js(`[...document.querySelectorAll(".tab")].find((t) => t.textContent.trim() === "Browse").click(); return true`); await sleep(600);
      await paste(url); await sleep(500);
      if (await dialog()) { v.push("a paste on Browse opened the dialog"); await closeDialog(); }
      // a link the library has (this cell's own, so the cell stands alone): said, and Import off
      const have = `${S}/files/pastehave.mp4`;
      if ((await http("POST", "/library/import-link", { url: have })).status !== 200) v.push("couldn't import the cell's own link through the API");
      await load();
      await paste(have);
      if (!(await lineIs("found", 3000))) v.push("the library's own link wasn't resolved");
      else { const h = await linkState(); if (!h.have || !h.goOff) v.push(`the library's own link: ${J(h)}, want "In your library", Import off`); }
      await shot("link-have", ".imp-modal");
      await closeDialog();
      return v;
    });

    await cell("import:link:drop — a web link dragged from a browser opens the dialog on it", async () => {
      await load();
      const url = `${S}/files/dropped.mp4`;
      await js(`const dt = new DataTransfer(); dt.setData("text/uri-list", "# a comment\\n" + ${J(url)});
        for (const t of ["dragenter", "dragover", "drop"]) document.body.dispatchEvent(new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true })); return true`);
      if (!(await lineIs("found", 4000))) return [`a dropped link: ${J(await linkState())}`];
      const s = await linkState();
      const v = s.value === url && s.name === "dropped" ? [] : [`the dialog on ${J(s.value)} naming ${J(s.name)}, want the dropped link`];
      await closeDialog();
      return v;
    });

    await cell("import:link:close — Close while it imports: the dialog leaves, the import goes on and lands", async () => {
      const v = [];
      await load();
      if (!(await openLinkFromMenu())) return ["no Import from a link… in the menu"];
      await js(`${setLink(`${S}/slow/closed.mp4`)} return true`);
      if (!(await lineIs("found"))) return [`the link: ${J(await linkState())}`];
      await js(`document.querySelector("[data-import-go]").click(); return true`);
      await sleep(400);
      if ((await linkState())?.cancel !== "Close") v.push(`while importing the button says ${J((await linkState())?.cancel)}, want "Close"`);
      await closeDialog();
      if (await dialog()) v.push("Close didn't close the dialog");
      if ((await titles()).includes("closed")) v.push("it landed before Close — proved nothing");
      if (!(await waitFor(async () => (await titles()).includes("closed"), 10000))) v.push("the import didn't go on after Close");
      if (!(await waitFor(async () => (await statusText()) === "Imported: closed", 4000))) v.push(`the status line says ${J(await statusText())}`);
      return v;
    });

    await cell("import:link:error — the import's refusal shows under the item, which stays: Import tries again, an edit clears it", async () => {
      const v = [];
      await load();
      if (!(await openLinkFromMenu())) return ["no Import from a link… in the menu"];
      await js(`${setLink(`${S}/fake.mp4`)} return true`);
      if (!(await lineIs("found"))) return [`the link: ${J(await linkState())}`];
      const want = "The link's file isn't a video.";
      const failedShown = () => waitFor(async () => (await linkState())?.failed === want, 8000);
      await js(`document.querySelector("[data-import-go]").click(); return true`);
      if (!(await failedShown())) return [`no refusal shown: ${J(await linkState())}`];
      await sleep(1200); // it stays: nothing asks about the link again or takes the note away
      const s = await linkState();
      // what the link names stays, and so does Import: a failure that passes (the server was down) needs no edit to retry
      if (s.line !== "found" || s.failed !== want || s.goOff || s.go !== "Import" || s.cancel !== "Cancel" || s.inputOff) v.push(`after the refusal: ${J(s)}`);
      await shot("link-error", ".imp-modal");
      // Import again: it tries (the server is asked a second time) and says the same
      await js(`document.querySelector("[data-import-go]").click(); return true`);
      if (!(await waitFor(async () => fakeAsked >= 2, 8000))) v.push(`trying again asked the server ${fakeAsked} time(s) in all, want 2`);
      // its end: the field back on and the refusal under the item again (an old note still fading out is no answer)
      if (!(await waitFor(async () => { const t = await linkState(); return t.go === "Import" && !t.inputOff && t.failed === want; }, 8000)))
        v.push(`trying again: no refusal shown (${J(await linkState())})`);
      // an edit clears it
      await js(`${setLink(`${S}/fake.mp4 `)} return true`); await sleep(400);
      if ((await linkState()).failed != null) v.push(`an edit left the refusal: ${J(await linkState())}`);
      await closeDialog();
      if ((await titles()).includes("fake")) v.push("the page landed in the library");
      return v;
    });

    await cell("import:link:look — theme colours, the progress fill's glow (none under no-glow), bg-live keeps the fill; pictures", async () => {
      const v = [];
      await load();
      if (!(await openLinkFromMenu())) return ["no Import from a link… in the menu"];
      const colours = (sel, prop = "color") => js(`const e = document.querySelector(${J(sel)}); if (!e) return null;
        const probe = document.createElement("i"); document.body.append(probe);
        const tv = (n) => { probe.style.color = "var(" + n + ")"; return getComputedStyle(probe).color; };
        const out = { got: getComputedStyle(e)[${J(prop)}], danger: tv("--danger"), subtext: tv("--subtext"), accent: tv("--accent") }; probe.remove(); return out;`);
      await js(`${setLink(`${S}/page`)} return true`);
      if (await lineIs("error")) { const c = await colours("[data-import-link-error]"); if (c.got !== c.danger) v.push(`the error line ${c.got}, want --danger ${c.danger}`); }
      else v.push("no error line");
      await js(`${setLink(`${S}/slow/looked.mp4`)} return true`);
      if (!(await lineIs("found"))) return [...v, "the link wasn't resolved"];
      const w = await colours("[data-import-link-where]"); if (w.got !== w.subtext) v.push(`where it comes from ${w.got}, want --subtext ${w.subtext}`);
      const g = await colours(".imp-link-row .imp-gico"); if (g.got !== g.accent) v.push(`the chip ${g.got}, want --accent ${g.accent}`);
      await js(`document.querySelector("[data-import-go]").click(); return true`);
      if (!(await waitFor(() => js(`return !!document.querySelector("[data-import-link-progress] .dl-fill")`), 3000))) return [...v, "no progress bar"];
      await sleep(300);
      const f = await colours("[data-import-link-progress] .dl-fill", "backgroundColor"); if (f.got !== f.accent) v.push(`the fill ${f.got}, want --accent ${f.accent}`);
      const glow = () => js(`return getComputedStyle(document.querySelector("[data-import-link-progress] .dl-fill")).boxShadow`);
      // lit: a shadow with a real colour and spread (no-glow turns --glow-sm into a clear zero shadow)
      const lit = (sh) => !!sh && sh !== "none" && !/^(rgba\(0, 0, 0, 0\) 0px 0px 0px 0px(, )?)+$/.test(sh) && /px [1-9]/.test(sh);
      const g1 = await glow();
      if (!lit(g1)) v.push(`the fill doesn't glow (${g1})`);
      await js(`document.documentElement.classList.add("no-glow", "bg-live"); return true`); await sleep(150);
      const g2 = await glow();
      if (lit(g2)) v.push(`no-glow: the fill still glows (${g2})`);
      const fill = await js(`return getComputedStyle(document.querySelector(".imp-modal")).backgroundColor`);
      if (/rgba\(0, 0, 0, 0\)|transparent/.test(fill)) v.push(`bg-live: the dialog lost its fill (${fill})`);
      await shot("link-noglow-bglive", ".imp-modal");
      await js(`document.documentElement.classList.remove("no-glow", "bg-live"); return true`);
      await waitFor(async () => (await dialog()) == null, 10000);
      return v;
    });
    server.close();

    await cell("import:look — theme colours, the drop frame's glow (none under no-glow), bg-live keeps the dialog's fill; pictures", async () => {
      const v = [];
      await load();
      const d = tree("l");
      await http("POST", "/library/import", { path: path.join(d, "lhave.mp4"), title: "lhave" });
      await stubPicker(d);
      await js(`document.querySelector("[data-import-btn]").click(); return true`);
      if (!(await found())) return ["the dialog didn't list the folder"];
      const col = await js(`const cs = (s) => { const e = document.querySelector(s); return e ? getComputedStyle(e) : null; };
        const probe = document.createElement("i"); document.body.append(probe);
        const tv = (n) => { probe.style.color = "var(" + n + ")"; return getComputedStyle(probe).color; };
        const out = { have: cs(".imp-have")?.color, success: tv("--success"), gico: cs(".imp-gico")?.color, accent: tv("--accent"),
          fill: cs(".imp-modal")?.backgroundColor };
        probe.remove(); return out;`);
      if (col.have !== col.success) v.push(`"In your library" ${col.have}, want --success ${col.success}`);
      if (col.gico !== col.accent) v.push(`group chip ${col.gico}, want --accent ${col.accent}`);
      await shot("look", ".imp-modal");
      await js(`document.documentElement.classList.add("bg-live"); return true`); await sleep(200);
      const fill = await js(`return getComputedStyle(document.querySelector(".imp-modal")).backgroundColor`);
      if (/rgba\(0, 0, 0, 0\)|transparent/.test(fill)) v.push(`bg-live: the dialog lost its fill (${fill})`);
      await js(`document.documentElement.classList.remove("bg-live"); return true`);
      await js(`[...document.querySelectorAll(".imp-actions .btn")].find((b) => b.textContent.trim() === "Cancel").click(); return true`);
      await gone();
      const frameGlow = async () => js(`const dt = new DataTransfer(); dt.setData("text/uri-list", "file:///tmp");
        document.body.dispatchEvent(new DragEvent("dragenter", { dataTransfer: dt, bubbles: true, cancelable: true }));
        await new Promise((r) => setTimeout(r, 450)); const e = document.querySelector("[data-import-drop]"); const sh = e ? getComputedStyle(e).boxShadow : null;
        document.body.dispatchEvent(new DragEvent("dragleave", { dataTransfer: dt, bubbles: true })); await new Promise((r) => setTimeout(r, 400)); return sh;`);
      const lit = (sh) => !!sh && sh !== "none" && !/^(rgba\(0, 0, 0, 0\) 0px 0px 0px 0px(, )?)+$/.test(sh) && /px [1-9]/.test(sh);
      const g1 = await frameGlow();
      if (!lit(g1)) v.push(`the drop frame doesn't glow (${g1})`);
      await js(`document.documentElement.classList.add("no-glow"); return true`);
      const g2 = await frameGlow();
      if (g2 !== "none") v.push(`no-glow: the drop frame still glows (${g2})`);
      await js(`document.documentElement.classList.remove("no-glow"); return true`);
      return v;
    });
  } catch (e) {
    console.log(`FAIL  probe crashed: ${e.stack || e.message}`);
    results.push({ name: "crash", v: [e.message] });
  }
  const failed = results.filter((r) => r.v.length);
  console.log(`IMPORT ${results.length - failed.length}/${results.length} passed`);
  app.exit(failed.length ? 1 : 0);
});
