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
//   import:files        the Import's right-click menu has "Import files…"; picked files open the dialog on just them
//   import:drop:<m>     files dragged over the window from a file manager (text/uri-list file:// URIs) show the drop frame
//                       (motion on: it scales in; off: it fades), leaving the window hides it, a drop opens the dialog on them
//   import:settings     Settings → "Add folder" opens the dialog as "Watch a folder" with "Keep watching this folder" ticked;
//                       importing lists the folder in Watched folders with its wallpaper count (all six); its "Copy files instead of
//                       linking" saves the folder's copy choice; a file written into the folder shows up in the Library
//                       without a click; the remove button stops the watching (the row glides out) and keeps the wallpapers
//   import:look         theme colours (the in-library pill in --success, the group chips in --accent), the drop frame's
//                       glow (none under no-glow), bg-live: the dialog keeps its own fill; pictures import-*.png
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

    await cell("import:files — the Import's right-click: Import files… opens the dialog on just them", async () => {
      const v = [];
      await load();
      const d = tree("f");
      const files = [path.join(d, "fa.mp4"), path.join(d, "fc.gif")];
      await stubPicker(d, files);
      const r = await js(`const b = document.querySelector("[data-import-btn]").getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }`);
      win.webContents.sendInputEvent({ type: "mouseDown", x: Math.round(r.x), y: Math.round(r.y), button: "right", clickCount: 1 });
      win.webContents.sendInputEvent({ type: "mouseUp", x: Math.round(r.x), y: Math.round(r.y), button: "right", clickCount: 1 });
      if (!(await waitFor(() => js(`return [...document.querySelectorAll(".sel-pop button")].some((b) => b.textContent.includes("Import files"))`), 3000)))
        return ["no \"Import files…\" in the Import's right-click menu"];
      await js(`[...document.querySelectorAll(".sel-pop button")].find((b) => b.textContent.includes("Import files")).click(); return true`);
      if (!(await found())) return ["the dialog didn't list the picked files"];
      const s = await dialog();
      const paths = s.groups.flatMap((g) => g.items.map((i) => i.path)).sort();
      if (J(paths) !== J([...files].sort())) v.push(`listed ${J(paths)}, want just ${J(files)}`);
      if (s.summary !== "1 video, 1 GIF") v.push(`summary ${J(s.summary)}`);
      if (s.watch !== null) v.push("files offered a folder watch");
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
      const fr = (await js(`const s = ${SAMPLE({ row: `[data-watched="${d}"]` }, 700)}; document.querySelector('[data-watched="${d}"] [data-watched-remove]').click(); return await s`)).row;
      const fades = fr.filter((f) => f[1] != null && f[1] > 0.02 && f[1] < 0.95).length;
      if (!fades) v.push(`the row popped out (${brief(fr)})`);
      if (!(await waitFor(async () => !((await http("GET", "/settings")).json?.watchedFolders ?? []).some((w) => w.path === d), 8000))) v.push("remove didn't stop the watching");
      if (!(await titles()).includes("wa")) v.push("removing the folder took its wallpapers away");
      return v;
    });

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
