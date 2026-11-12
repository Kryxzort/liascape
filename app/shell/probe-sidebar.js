// Wallpaper Engine-style sidebar probe — `scripts/test-ui-matrix.sh --probe probe-sidebar.js` (the matrix's hermetic
// stack: private backend + headless liascape-player + this tree's UI bundle on a private Xvfb). docs/decisions.md §
// "Replace the card settings and preview modals with an item sidebar" (docs/superpowers/specs/2026-11-10-we-sidebar-design.md).
//   lib:click            a plain click focuses the card AND applies it (WE); the sidebar shows it — volume, speed, the actions
//   lib:rightClick       right-click = the sidebar on that card, nothing applies, no menu (docs/decisions.md § "Open the item
//                        sidebar on right-click; no context menus"); with the sidebar open it moves to the card; Escape closes it
//   lib:reflow           a right-click on a card in a scrolled grid while the sidebar is closed: the docked sidebar re-fits the
//                        grid's columns, the card stays in view near where it was (real input events)
//   lib:fourOptions      the sidebar's Open in file manager (stubbed /open), Delete (+ Undo), Delete from source (a Workshop item)
//   lib:play             the picture is the Play control (no icon): a click applies the item, then the green frame — no
//                        "Playing now" pill — and a Looping chip only while loop-current is on; no playlist toggle in the head; the head's playlist toggle adds / removes it (the Play / In playlist row is gone)
//   lib:preview          the picture's preview switch: only the options the item has (k1 GIF + Video, k2 none, s2 none, s1 with
//                        a trailer Picture + YouTube), a pick shows its layer and is kept for the next item; the first preview
//                        ever opens muted; the trailer (stubbed) remembers the shared mute + level
//   preview:volume       the Video preview's own volume slider beside the mute chip: opens muted (slider 0); unmute plays at the
//                        item's wallpaper volume; the slider sets the <video>'s volume and the saved level; 0 shows the
//                        muted glyph and unmuting brings the last level back; the wheel steps it (the sidebar doesn't scroll);
//                        Tab from the chip reaches it, arrows / Home step it (the grid stays); the mute and the level kept
//                        across items and a reload; never the global / the item's volume, nothing applied
//   preview:follow       until the preview's own slider moves, its level is the item's effective wallpaper volume (k1's own,
//                        k2's the global), following the sidebar's Volume row live, and the YouTube trailer (a stub player)
//                        is told the same; once moved, every item keeps the preview's own level
//   preview:hiddenTab    an unmuted, playing Video preview / YouTube trailer (stub player) in the Library sidebar pauses
//                        when Browse / Settings shows (the Library stays mounted, hidden) and plays on, unmuted, back on
//                        Library; a trailer the user paused stays paused
//   look:previewVolume   the slider's pill slides + fades out from under the chip on hover (per frame); motion off: it fades in place,
//                        no pointer while hidden, inside the picture, theme text + accent fill; no chip glow under no-glow; a dark
//                        fill under bg-live. Screenshots side-pvol-*.png
//   look:strip:<w>x<h>   the preview switch is the segmented control's strip fused to the picture: 0 px gap, the same left /
//                        right edges, the unit as wide as the content (full width at 16:9), rounded strip top + picture bottom,
//                        shorter than the old pills; the highlight glides (per frame) and lands centred, jumps with motion off;
//                        the glow wraps the unit (gone under no-glow); hovering a playable picture grows the whole unit; one
//                        option → no strip, the picture rounded all round; the strip keeps its dark fill under bg-live
//                        (sizes 1920x1080 and 1100x700: run with LIASCAPE_MATRIX_SCREEN=2560x1440). Screenshots side-strip-*.png
//   lib:slide            an item switch slides like a carousel by where the new card sits: the same row, right → in from the
//                        right (the old out left), left mirrored; a row below → rises from below, above → mirrored; the outgoing copy inert + after the live one, gone after ~0.3 s; motion off → a cross-fade in place
//   look:plCheck         a card's CHECKED playlist box, hovered: still accent, with a dark visible tick (pixels)
//   look:focusRing       a click + a letter: no focus ring on the clicked button; Tab: the accent ring; a click ends it
//   look:liveBg          live wallpaper behind the tabs → the panel fully see-through (like Settings), its section cards dark, a see-through head,
//                        the content scrolling below it; opaque without
//   lib:volume           its volume slider persists the item's own volume
//   lib:still            a `library-item-changed` (two volume keybinds on the playing item) moves nothing and replays nothing;
//                        the slider follows (guards against a morph replay on an item's update)
//   lib:keys             ← → ↑ ↓ move the focus between cards, Enter applies, Escape closes
//   lib:selection        a focused card inside a Ctrl-selection: the sidebar says how many it applies to
//   bar:settings         a right-click on a playlist bar item opens the sidebar on it; nothing applies, no menu
//   lib:levels           Basic hides Speed; an item with its own speed shows it anyway
//   lib:popin            a scene's sidebar shows its body once, with its scene properties in it — nothing pops in later
//   browse:click         a Browse click / right-click opens the Browse sidebar and downloads nothing
//   browse:inLibrary     an item the library has: "In your library" + Show in Library → the Library tab, that item focused
//   browse:dblclick      a double-click downloads & applies
//   motion:on|off|reduced the open slides/fades (transform + opacity only); animations off / reduced motion → only opacity
//                        animates and nothing moves: the panel fades in, a switch cross-fades the old content into the new, the
//                        close fades out (per frame: in-between opacity frames, the boxes still)
//   look:focus           the focused card's ring is the accent (outline colour), off the card, with the accent glow; Glow effects
//                        off → the ring without the glow
//   look:sideTags        the sidebar's tags: no "Wallpaper", no type, none repeating a pill it shows; a genre stays
//   look:sideRhythm      the sidebar's sections 12 px apart, the tag row included; its tags wear the pills' see-through fill and edge
//                        the preview's switch strip and mute button wear the sidebar tiles' fill and edge
//   look:locator         "go to playing" (grid + bar): the spotlight (dim + rings + glow) appears, the rings ripple, all gone in
//                        ≤ 2 s; Glow effects off → no glow layer, still dim + rings; animations off → a still highlight that fades
//                        in and out (opacity only, nothing scales)
//   look:dlHover         a Browse card's download button under a real pointer: it lifts, its glow layer shows, the arrow nudges;
//                        the Browse sidebar's Download & Apply the same (computed styles differ from the un-hovered ones)
// Screenshots: <LIASCAPE_OUT>/side-<cell>.png. Exit 1 on any FAIL. LIASCAPE_ONLY = a regex over the cell names.
// LIASCAPE_SIDE_SHOTS="1920x1080,1100x700": the `shots:<size>` cells (pictures only — run with LIASCAPE_MATRIX_SCREEN=2560x1440).
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

const E = process.env;
const U = E.LIASCAPE_URL;
const { withToken, authHeaders } = require("./api-auth"); // the backend's API token (.claude/rules/backend/api.md § Security)
const MO = require("./motion-off"); // motion off: only opacity changes, nothing moves, appear / leave fade
const K = JSON.parse(E.LIASCAPE_CLIPS);
const SC = JSON.parse(E.LIASCAPE_SCENES || "[]");
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
const getSettings = async () => (await http("GET", "/settings")).json;
async function setSettings(patch) { await post("/settings", { ...(await getSettings()), ...patch }); }
const current = async () => (await http("GET", "/current")).json?.path ?? null;
const libItem = async (p) => ((await http("GET", "/library")).json || []).find((i) => i.videoPath === p);
const libItemByTitle = async (t) => ((await http("GET", "/library")).json || []).find((i) => i.title === t);

let win;
const js = (code) => win.webContents.executeJavaScript(code);
const PAGE = `window.__sb = {
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  byText(sel, text) { return [...document.querySelectorAll(sel)].find((e) => e.textContent.trim() === text); },
  card(t) { return [...document.querySelectorAll(".card.lib")].find((c) => c.querySelector(".lib-title")?.dataset.title === t); },
  thumb(t) { return this.card(t)?.querySelector(".thumb-wrap"); },
  bar(t) { return [...document.querySelectorAll(".pl-item")].find((e) => e.dataset.title === t); },
  ctx(el) { if (!el) throw new Error("no element to right-click"); const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.x + 10, clientY: r.y + 10 })); },
  menu() { return document.querySelector(".ctx-menu, .lib-ctx, .pl-ctx"); },
  key(k) { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); },
  side(kind) { return document.querySelector(kind ? '.side-panel[data-side="' + kind + '"]:not(.closing)' : ".side-panel:not(.closing)"); },
  sideTitle() { return this.side()?.querySelector(".side-head h2")?.textContent.trim() ?? null; },
  sideBtn(text) { return [...(this.side()?.querySelectorAll("button, a") ?? [])].find((b) => b.textContent.trim() === text || b.textContent.trim().startsWith(text + " ")); },
  sideRow(name) { return this.side()?.querySelector('[data-side-row="' + name + '"]'); },
  setValue(el, v) { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(el, String(v)); el.dispatchEvent(new Event("input", { bubbles: true })); },
  rect(el) { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; },
  // a right-click: the sidebar on that card, without applying it
  // (the old UI's menu "Settings" is followed too — only so a RED run against it measures the cell's own contract; lib:rightClick
  // is the one that fails on a menu)
  async openSide(t) { this.ctx(this.thumb(t)); await this.sleep(150); this.byText(".lib-ctx button", "Settings")?.click();
    if (!await this.waitSide("library")) throw new Error("no sidebar after a right-click on " + t); await this.sleep(150);
    if (this.sideTitle() !== t) throw new Error("the sidebar shows " + this.sideTitle() + ", not " + t); },
  async closeAll() { for (let i = 0; i < 3; i++) { if (!document.querySelector(".side-panel, .ctx-menu")) return; this.key("Escape"); await this.sleep(300); } },
  accent() { const d = document.createElement("div"); d.style.color = "var(--accent)"; document.body.appendChild(d); const c = getComputedStyle(d).color; d.remove(); return c; },
  op(el) { let o = 1; for (let e = el; e && e !== document.body; e = e.parentElement) o *= +getComputedStyle(e).opacity; return o; },
  async waitSide(kind, ms = 2000) { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (this.side(kind)) return true; await this.sleep(30); } return false; },
}; true`;
const page = (code) => js(`(async () => { const m = window.__sb; ${code} })()`);
async function loadUi() {
  await win.loadURL(withToken(U + "/"));
  // /open would start a real file manager, the unsubscribe a Steam call: recorded, never sent
  await js(`(() => { window.__opened = []; const f = window.fetch; window.fetch = (u, o) => { const p = String(u).replace(/^https?:\\/\\/[^/]+/, "").split("?")[0];
    if ((o?.method || "GET") === "POST" && (p === "/open" || p.startsWith("/workshop/unsubscribe") || p === "/library/delete-from-source")) { window.__opened.push({ p, body: o?.body ?? null });
      return Promise.resolve(new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } })); }
    return f(u, o); }; })(); true`);
  for (let i = 0; i < 100; i++) { if (await js(`document.querySelectorAll('.card.lib').length`) >= 4) break; await sleep(100); }
  await js(PAGE); await sleep(400);
}
const send = (e) => win.webContents.sendInputEvent(e);
const mv = async (x, y, ms = 0) => { send({ type: "mouseMove", x: Math.round(x), y: Math.round(y) }); if (ms) await sleep(ms); };
const rightAt = async (x, y) => { send({ type: "mouseDown", x: Math.round(x), y: Math.round(y), button: "right", clickCount: 1 }); await sleep(40);
  send({ type: "mouseUp", x: Math.round(x), y: Math.round(y), button: "right", clickCount: 1 }); };
async function shot(name) { const img = await win.webContents.capturePage(); fs.writeFileSync(path.join(OUT, `side-${name}.png`), img.toPNG()); }
async function tab(name) { await page(`m.byText(".tab", ${JSON.stringify(name)}).click();`); await sleep(700); }
async function reducedMotion(on) {
  const d = win.webContents.debugger;
  if (!d.isAttached()) d.attach("1.3");
  await d.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: on ? "reduce" : "" }] });
}
// "Smooth window animations" through its own Settings row (a /settings POST doesn't reach the open page's store)
async function setMotion(on) {
  await tab("Settings");
  await page(`const row = [...document.querySelectorAll(".srow")].find((r) => r.querySelector(".slabel")?.textContent.includes("Smooth window animations"));
    if (!row) throw new Error("no Smooth window animations row");
    const cb = row.querySelector("input[type=checkbox]"); if (cb.checked !== ${on}) cb.click(); await m.sleep(500);`);
  await tab("Library");
}
// "Wallpaper behind every tab" (the live wallpaper behind the UI → :root.bg-live, the translucent chrome): an Advanced-level row,
// hidden at the run's Standard level → set it through /settings and reload the page (a POST doesn't reach the open store)
async function setBgLive(on) {
  await setSettings({ liveWallpaperBehindAllTabs: on });
  await loadUi(); await tab("Library"); await sleep(600);
}
const T = (p) => (p ? path.basename(p).replace(/\.[^.]+$/, "") : String(p));
// the sidebar previews' saved sound (app/ui/src/components/sidePreview.ts)
const PV_KEYS = `["liascape.previewVolume", "liascape.previewVolumeLast", "liascape.previewMuted"]`;
// an item's effective wallpaper volume (`override ?? global`), by its card title
async function wallOf(title) {
  const it = await libItemByTitle(title);
  if (!it) throw new Error("no library item " + title);
  return it.volumeOverride ?? (await getSettings()).volume ?? 100;
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
    try { await page(`await m.closeAll();`); } catch { /* page gone */ }
  };
  try {
    await post("/playlist/state", { videoPaths: K.slice(0, 4), settings: null, name: null });
    await setSettings({ morphs: true, glows: true, settingsLevel: "standard", autoAddWeWallpapersToLibrary: false, volumeKeyTarget: "auto" });
    await loadUi();

    await cell("lib:click", async () => {
      await page(`m.thumb("k2").click();`);
      const open = await page(`return await m.waitSide("library");`);
      if (!open) return ["no Library sidebar after a click on k2"];
      const r = await page(`await m.sleep(400); return { title: m.sideTitle(), ranges: m.side().querySelectorAll("input[type=range]").length,
        btns: ["Open in file manager", "Delete"].filter((t) => m.sideBtn(t)), play: !!m.side().querySelector("[data-side-play], [data-side-playing]"),
        modal: !!document.querySelector(".modal-backdrop"),
        focused: [...document.querySelectorAll(".card.lib.focused")].map((c) => c.querySelector(".lib-title")?.dataset.title) };`);
      const v = [];
      if (r.title !== "k2") v.push(`the sidebar shows "${r.title}", not k2`);
      if (r.ranges < 2) v.push(`${r.ranges} sliders in the sidebar (volume + speed)`);
      for (const b of ["Open in file manager", "Delete"]) if (!r.btns.includes(b)) v.push(`no "${b}" button`);
      if (!r.play) v.push(`no Play control / Playing now badge on the picture`);
      if (r.modal) v.push("a modal opened too");
      if (r.focused.join() !== "k2") v.push(`focused cards: [${r.focused}]`);
      let cur = null; for (let i = 0; i < 50 && (cur = await current()) !== K[1]; i++) await sleep(100);
      if (cur !== K[1]) v.push(`the click didn't apply k2 (/current ${T(cur)})`);
      await shot("lib-click");
      return v;
    });

    await cell("lib:rightClick", async () => {
      const v = [];
      const before = await current();
      await page(`await m.closeAll(); m.ctx(m.thumb("k3")); await m.waitSide("library"); await m.sleep(250);`);
      let r = await page(`return { side: !!m.side(), title: m.sideTitle(), menu: !!m.menu() };`);
      if (r.menu) v.push("a right-click opened a context menu");
      if (!r.side) return [...v, "a right-click didn't open the sidebar"];
      if (r.title !== "k3") v.push(`the right-click opened the sidebar on "${r.title}", not k3`);
      await shot("lib-rightclick");
      // open: a right-click on another card moves the sidebar to it
      await page(`m.ctx(m.thumb("k4")); await m.sleep(300);`);
      r = await page(`return { title: m.sideTitle(), menu: !!m.menu() };`);
      if (r.title !== "k4") v.push(`with the sidebar open, a right-click on k4 left it on "${r.title}"`);
      if (r.menu) v.push("a context menu on that right-click");
      await page(`m.key("Escape"); await m.sleep(400);`);
      if (await page(`return !!m.side();`)) v.push("Escape didn't close the sidebar");
      await sleep(400);
      if ((await current()) !== before) v.push(`a right-click applied (${T(before)} → ${T(await current())})`);
      return v;
    });

    await cell("lib:reflow", async () => {
      const v = [];
      const s0 = await getSettings();
      // 24 more items (hard links of k1, "x01".."x24") so the grid scrolls: the library holds only 7 and fits any window
      const INDEX = path.join(path.dirname(path.dirname(K[0])), "index.json"), idx0 = fs.readFileSync(INDEX, "utf8");
      const k1key = path.basename(path.dirname(K[0])), extra = [];
      const idx = JSON.parse(idx0);
      for (let i = 1; i <= 24; i++) {
        const key = `x${String(i).padStart(2, "0")}`, d = path.join(path.dirname(path.dirname(K[0])), key);
        fs.mkdirSync(d, { recursive: true }); fs.linkSync(K[0], path.join(d, key + path.extname(K[0]))); extra.push(d);
        idx[key] = { ...(idx[k1key] || {}), title: key, addedAt: new Date(Date.UTC(2020, 0, i)).toISOString() };
      }
      fs.writeFileSync(INDEX, JSON.stringify(idx));
      try {
        await setSettings({ cardSize: "Large" });
        win.setContentSize(1000, 560); await sleep(300); await loadUi(); await sleep(800);
        await page(`await m.closeAll(); const sc = document.querySelector(".lib-scroll"); sc.scrollTop = (sc.scrollHeight - sc.clientHeight) / 2; await m.sleep(400);`);
        // the lowest fully visible card that isn't playing
        const t = await page(`const sc = document.querySelector(".lib-scroll").getBoundingClientRect(); const cur = ${JSON.stringify(T(await current()))};
          const vis = [...document.querySelectorAll(".card.lib")].filter((c) => { const b = c.getBoundingClientRect(); return b.top >= sc.top && b.bottom <= sc.bottom; })
            .map((c) => c.querySelector(".lib-title")?.dataset.title).filter((x) => x && x !== cur);
          return vis[vis.length - 1] ?? null;`);
        if (!t) return ["no fully visible card in the scrolled grid"];
        const b0 = await page(`const sc = document.querySelector(".lib-scroll"); return { r: m.rect(m.card(${JSON.stringify(t)})), top: sc.getBoundingClientRect().top, h: sc.clientHeight, scroll: sc.scrollTop, cols: getComputedStyle(sc).getPropertyValue("--cols") };`);
        await mv(b0.r.x + b0.r.w / 2, b0.r.y + b0.r.h / 2, 300);
        await rightAt(b0.r.x + b0.r.w / 2, b0.r.y + b0.r.h / 2);
        await sleep(700);
        const b1 = await page(`const sc = document.querySelector(".lib-scroll"); const s = sc.getBoundingClientRect(); return { r: m.rect(m.card(${JSON.stringify(t)})), top: s.top, bottom: s.bottom, title: m.sideTitle(), menu: !!m.menu(), cols: getComputedStyle(sc).getPropertyValue("--cols") };`);
        console.log(`        ${t}: y ${b0.r.y.toFixed(0)} (cols ${b0.cols}, scroll ${b0.scroll.toFixed(0)}) → ${b1.r.y.toFixed(0)} (cols ${b1.cols}), view ${b1.top.toFixed(0)}–${b1.bottom.toFixed(0)}`);
        if (b1.title !== t) v.push(`the right-click opened "${b1.title}", not ${t}`);
        if (b1.menu) v.push("a context menu opened");
        if (b0.cols === b1.cols) v.push(`the grid kept ${b0.cols} columns — the cell proves nothing (the sidebar didn't dock?)`);
        if (b1.r.y < b1.top - 1 || b1.r.y + b1.r.h > b1.bottom + 1) v.push(`after the re-fit ${t} is out of view (${b1.r.y.toFixed(0)}–${(b1.r.y + b1.r.h).toFixed(0)} vs ${b1.top.toFixed(0)}–${b1.bottom.toFixed(0)})`);
        else if (Math.abs(b1.r.y - b0.r.y) > Math.max(48, b1.r.h * 0.5)) v.push(`${t} jumped ${(b1.r.y - b0.r.y).toFixed(0)} px vertically (it should stay near where it was)`);
        await shot("lib-reflow");
      } finally {
        await mv(5, 5); await page(`await m.closeAll();`);
        fs.writeFileSync(INDEX, idx0); for (const d of extra) fs.rmSync(d, { recursive: true, force: true }); // the stack's own temp library
        await setSettings({ cardSize: s0.cardSize });
        win.setContentSize(1400, 900); await sleep(300); await loadUi();
      }
      return v;
    });

    await cell("lib:fourOptions", async () => {
      const v = [];
      await page(`await m.openSide("k3"); await m.sleep(300);`);
      await page(`window.__opened = []; m.sideBtn("Open in file manager")?.click(); await m.sleep(300);`);
      const opened = await js(`window.__opened`);
      const o = opened.find((x) => x.p === "/open");
      if (!o || !JSON.parse(o.body || "{}").reveal || JSON.parse(o.body || "{}").path !== K[2]) v.push(`Open in file manager sent ${JSON.stringify(opened)}`);
      // a Workshop item (s1, auto-import off): Delete from source is there
      await page(`await m.openSide("s1"); await m.sleep(400);`);
      if (!await page(`return !!m.sideBtn("Delete from source");`)) v.push("no Delete from source on the Workshop item s1");
      // Delete (k4) → gone from the library, the sidebar closes; Undo brings it back
      await page(`await m.openSide("k4"); await m.sleep(300); m.sideBtn("Delete")?.click();`);
      let gone = false; for (let i = 0; i < 40 && !gone; i++) { gone = !(await libItem(K[3])); if (!gone) await sleep(100); }
      if (!gone) v.push("Delete didn't trash k4");
      await sleep(400);
      if (await page(`return m.sideTitle() === "k4";`)) v.push("the sidebar still shows the deleted k4");
      await page(`m.byText(".topbar .btn", "Undo")?.click();`);
      let back = false; for (let i = 0; i < 40 && !back; i++) { back = !!(await libItem(K[3])); if (!back) await sleep(100); }
      if (!back) v.push("Undo didn't restore k4");
      await post("/playlist/state", { videoPaths: K.slice(0, 4), settings: null, name: null });
      await sleep(600);
      return v;
    });

    await cell("lib:volume", async () => {
      await page(`await m.openSide("k3"); await m.sleep(300);
        const r = m.sideRow("volume")?.querySelector("input[type=range]"); if (!r) throw new Error("no volume row"); m.setValue(r, 37);`);
      await sleep(900);
      const it = await libItem(K[2]);
      const v = it?.volumeOverride === 37 ? [] : [`k3's volumeOverride ${it?.volumeOverride}, expected 37`];
      await post("/library/volume", { path: K[2], intValue: null });
      return v;
    });

    await cell("lib:still", async () => {
      await setSettings({ volumeKeyTarget: "item" });
      await post("/apply", { path: K[0] }); await sleep(1500);
      await page(`await m.openSide("k1");`);
      await sleep(1200); // opened + settled
      const r = await page(`const media = m.side().querySelector("[data-side-media]"); const before = m.rect(media);
        const vol0 = m.sideRow("volume")?.querySelector("input")?.value; const out = [];
        const t0 = performance.now();
        fetch("/volume", { method: "POST", headers: { "Content-Type": "application/json", "X-Liascape-Token": sessionStorage.getItem("liascape_token") }, body: JSON.stringify({ delta: -5 }) });
        setTimeout(() => fetch("/volume", { method: "POST", headers: { "Content-Type": "application/json", "X-Liascape-Token": sessionStorage.getItem("liascape_token") }, body: JSON.stringify({ delta: -5 }) }), 900);
        await new Promise((res) => { const f = () => { const s = m.side(); const md = s?.querySelector("[data-side-media]");
          out.push({ open: !!s, r: md ? m.rect(md) : null, anims: s ? s.getAnimations({ subtree: true }).filter((a) => a.playState === "running" && !(a.effect?.target?.matches?.("img, video"))).length : 0 });
          if (performance.now() - t0 < 2200) requestAnimationFrame(f); else res(); }; requestAnimationFrame(f); });
        return { before, out, vol0, vol1: m.sideRow("volume")?.querySelector("input")?.value };`);
      const v = [];
      const moved = r.out.filter((x) => !x.r || Math.abs(x.r.x - r.before.x) > 0.5 || Math.abs(x.r.y - r.before.y) > 0.5 || Math.abs(x.r.w - r.before.w) > 0.5);
      const anim = r.out.filter((x) => x.anims > 0);
      if (r.out.some((x) => !x.open)) v.push("the sidebar closed / blinked during the item updates");
      if (moved.length) v.push(`the picture moved in ${moved.length}/${r.out.length} frames`);
      if (anim.length) v.push(`the sidebar animated in ${anim.length}/${r.out.length} frames (a replayed open / swap)`);
      if (r.vol0 === r.vol1) v.push(`the volume slider didn't follow the keybinds (${r.vol0} → ${r.vol1})`);
      console.log(`        volume ${r.vol0} → ${r.vol1}, ${moved.length} moved, ${anim.length} animating frames`);
      await setSettings({ volumeKeyTarget: "auto" });
      await post("/library/volume", { path: K[0], intValue: null });
      return v;
    });

    await cell("lib:keys", async () => {
      const v = [];
      const order = await page(`return [...document.querySelectorAll(".card.lib .lib-title")].map((e) => e.dataset.title);`);
      const cols = await page(`return +getComputedStyle(document.querySelector(".lib-scroll")).getPropertyValue("--cols") || 1;`);
      const i0 = order.indexOf("k2");
      await page(`await m.openSide("k2"); await m.sleep(300); document.activeElement?.blur?.();`);
      await page(`m.key("ArrowRight"); await m.sleep(250);`);
      let t = await page(`return m.sideTitle();`);
      if (t !== order[i0 + 1]) v.push(`→ shows "${t}", expected the next card "${order[i0 + 1]}"`);
      await page(`m.key("ArrowLeft"); await m.sleep(250);`);
      t = await page(`return m.sideTitle();`);
      if (t !== "k2") v.push(`← shows "${t}", expected k2`);
      if (order[i0 + cols]) {
        await page(`m.key("ArrowDown"); await m.sleep(250);`);
        t = await page(`return m.sideTitle();`);
        if (t !== order[i0 + cols]) v.push(`↓ shows "${t}", expected "${order[i0 + cols]}" (${cols} columns)`);
        await page(`m.key("ArrowUp"); await m.sleep(250);`);
        t = await page(`return m.sideTitle();`);
        if (t !== "k2") v.push(`↑ shows "${t}", expected k2`);
      }
      await page(`m.key("Enter");`);
      let cur = null; for (let i = 0; i < 50 && (cur = await current()) !== K[1]; i++) await sleep(100);
      if (cur !== K[1]) v.push(`Enter didn't apply k2 (/current ${T(cur)})`);
      await page(`m.key("Escape"); await m.sleep(500);`);
      if (await page(`return !!document.querySelector(".side-panel");`)) v.push("Escape didn't close the sidebar");
      // nothing focused: the first arrow focuses the playing card
      await page(`m.key("ArrowRight"); await m.sleep(300);`);
      t = await page(`return m.sideTitle();`);
      if (t !== "k2") v.push(`the first arrow with nothing focused shows "${t}", expected the playing k2`);
      return v;
    });

    await cell("lib:selection", async () => {
      await page(`for (const t of ["k1", "k3"]) { m.thumb(t).dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true })); await m.sleep(250); } await m.sleep(300);`);
      const r = await page(`return { title: m.sideTitle(), text: m.side()?.querySelector(".side-head")?.textContent ?? "" };`);
      const v = [];
      if (r.title !== "k3") v.push(`the sidebar shows "${r.title}" after Ctrl-clicking k1, k3`);
      if (!/2 selected/.test(r.text)) v.push(`the head doesn't say it applies to 2 selected ("${r.text.slice(0, 80)}")`);
      await page(`m.key("Escape"); await m.sleep(400);`);
      if (await page(`return document.querySelectorAll(".card.lib.selected").length;`)) v.push("Escape left the selection");
      return v;
    });

    await cell("bar:settings", async () => {
      const before = await current();
      await page(`await m.closeAll(); m.ctx(m.bar("k2"));`);
      const open = await page(`return await m.waitSide("library");`);
      const r = await page(`await m.sleep(300); return { t: m.sideTitle(), menu: !!m.menu() };`);
      const v = open && r.t === "k2" ? [] : [`a right-click on the bar's k2 → sidebar ${open ? `"${r.t}"` : "closed"}`];
      if (r.menu) v.push("a context menu opened");
      await sleep(500);
      if ((await current()) !== before) v.push(`the right-click played something (${T(before)} → ${T(await current())})`);
      return v;
    });

    await cell("lib:levels", async () => {
      const v = [];
      await tab("Settings");
      await page(`document.querySelector('[data-settings-level] [data-level="basic"]').click(); await m.sleep(500);`);
      await post("/library/speed", { path: K[3], doubleValue: 1.5 });
      await loadUi();
      await page(`await m.openSide("k3"); await m.sleep(400);`);
      const k3 = await page(`return { vol: !!m.sideRow("volume"), spd: !!m.sideRow("speed") };`);
      if (!k3.vol) v.push("Basic hides the volume row");
      if (k3.spd) v.push("Basic still shows Speed on k3 (no speed of its own)");
      await page(`m.key("Escape"); await m.sleep(400); await m.openSide("k4"); await m.sleep(400);`);
      if (!await page(`return !!m.sideRow("speed");`)) v.push("Basic hides k4's Speed though k4 has its own speed (1.5×)");
      await shot("lib-levels-basic");
      await page(`m.key("Escape"); await m.sleep(300);`);
      await tab("Settings");
      await page(`document.querySelector('[data-settings-level] [data-level="standard"]').click(); await m.sleep(500);`);
      await tab("Library");
      await page(`await m.openSide("k3"); await m.sleep(400);`);
      if (!await page(`return !!m.sideRow("speed");`)) v.push("Standard doesn't show Speed");
      await post("/library/speed", { path: K[3], doubleValue: null });
      return v;
    });

    await cell("lib:popin", async () => {
      const r = await page(`m.ctx(m.thumb("s1")); const out = []; const t0 = performance.now();
        await new Promise((res) => { const f = () => { const s = m.side("library"); const b = s?.querySelector(".side-body");
          if (b) { let op = 1; for (let e = b; e && e !== document.body; e = e.parentElement) op *= +getComputedStyle(e).opacity;
            out.push({ t: performance.now() - t0, op, props: b.querySelectorAll("[data-scene-prop]").length, h: b.getBoundingClientRect().height, title: m.sideTitle() }); }
          if (performance.now() - t0 < 1800) requestAnimationFrame(f); else res(); }; requestAnimationFrame(f); });
        return out;`);
      const v = [];
      const shown = r.filter((x) => x.op > 0.05 && x.title === "s1");
      if (!shown.length) return ["s1's sidebar body never showed"];
      const bare = shown.filter((x) => x.props === 0);
      if (bare.length) v.push(`the body showed without its scene properties in ${bare.length} frames (first at ${bare[0].t.toFixed(0)} ms) — they pop in`);
      const h0 = shown[0].h, grow = shown.filter((x) => x.h > h0 + 2);
      if (grow.length) v.push(`the shown body grew ${h0.toFixed(0)} → ${grow[grow.length - 1].h.toFixed(0)} px (a section popped in)`);
      console.log(`        body shown at ${shown[0].t.toFixed(0)} ms with ${shown[0].props} properties, ${h0.toFixed(0)} px`);
      await shot("lib-scene");
      return v;
    });

    // the picture = the Play control (docs/decisions.md § "Make the sidebar's picture the Play control"); the head's toggle
    // a switch slides like a carousel, by where the new card sits relative to the old one, not a crossfade
    // — a later item (k3 after k1 in the grid) pushes the old content out left and slides in
    // from the right, an earlier one mirrored; the outgoing copy is inert, after the live one, gone after ~0.3 s; motion off → none
    const SLIDE = (t) => `m.ctx(m.thumb(${JSON.stringify(t)})); const t0 = performance.now(), out = { live: null, exit: null, exitInert: null, liveFirst: null, x0: null, y0: null, xMid: null, goneAt: null, title: null };
      await new Promise((res) => { const f = () => { const t = performance.now() - t0; const s = m.side();
        const live = s?.querySelector(".side-content:not(.side-exit)"), ex = s?.querySelector(".side-content.side-exit");
        if (live && out.live == null && !live.classList.contains("opening")) out.live = [...live.classList].filter((c) => c !== "side-content").join(" ");
        if (ex) { if (out.exit == null) { out.exit = [...ex.classList].filter((c) => c !== "side-content" && c !== "side-exit").join(" "); out.exitInert = ex.inert;
            out.liveFirst = !!(live && (live.compareDocumentPosition(ex) & Node.DOCUMENT_POSITION_FOLLOWING)); const mx = new DOMMatrix(getComputedStyle(live).transform); out.x0 = mx.m41; out.y0 = mx.m42; }
          if (t > 100 && t < 200 && out.xMid == null) out.xMid = new DOMMatrix(getComputedStyle(live).transform).m41; }
        else if (out.exit != null && out.goneAt == null) out.goneAt = Math.round(t);
        if (t < 900) requestAnimationFrame(f); else { out.title = m.sideTitle(); res(); } }; requestAnimationFrame(f); });
      return out;`;
    await cell("lib:slide", async () => {
      const v = [], J = JSON.stringify;
      await page(`await m.closeAll(); await m.openSide("k1"); await m.sleep(600);`);
      const a = await page(SLIDE("k3")); console.log(`        k1 → k3: ${J(a)}`);
      if (a.title !== "k3") return [`the sidebar didn't switch to k3 (${a.title})`];
      if (a.live !== "slide-next" || a.exit !== "to-left") v.push(`k1 → k3 (later): live ${a.live}, exit ${a.exit} — expected slide-next / to-left`);
      if (!(a.x0 > 40)) v.push(`k1 → k3: the new content doesn't start off to the right (x ${a.x0})`);
      if (a.exitInert !== true || a.liveFirst !== true) v.push(`the outgoing copy isn't inert / after the live content (${a.exitInert}, ${a.liveFirst})`);
      if (a.goneAt == null || a.goneAt > 600) v.push(`the outgoing copy stayed (${a.goneAt} ms)`);
      const b = await page(SLIDE("k1")); console.log(`        k3 → k1: ${J(b)}`);
      if (b.live !== "slide-prev" || b.exit !== "to-right") v.push(`k3 → k1 (earlier): live ${b.live}, exit ${b.exit} — expected slide-prev / to-right`);
      if (!(b.x0 < -40)) v.push(`k3 → k1: the new content doesn't start off to the left (x ${b.x0})`);
      if (await page(`return m.side().querySelectorAll("[data-side-playlist], .side-head-tools > *").length;`) !== 0) v.push("the head has tools after the slides (an outgoing copy's leaked, or the playlist toggle is back)");
      // above or below slides vertically — a card in a
      // row below rises in from below (the old one leaves upwards), back up → mirrored
      win.setContentSize(1000, 800); await sleep(300); await page(`await m.closeAll(); await m.openSide("k1"); await m.sleep(500);`); // the grid wraps (≈3 columns beside the docked panel)
      const rows = await page(`return ["k1","k2","k3","k4","s1","s2","s3","we1"].map((t) => { const r = m.thumb(t)?.getBoundingClientRect(); return r ? [t, Math.round(r.top)] : null; }).filter(Boolean);`);
      const top1 = rows.find((x) => x[0] === "k1")?.[1], below = rows.find((x) => x[1] > top1 + 20)?.[0];
      if (!below) v.push(`no card in a row below k1 to test the vertical slide (${J(rows)})`);
      else {
        const d = await page(SLIDE(below)); console.log(`        k1 → ${below} (a row below): ${J(d)}`);
        if (d.live !== "slide-below" || d.exit !== "to-top") v.push(`k1 → ${below} (row below): live ${d.live}, exit ${d.exit} — expected slide-below / to-top`);
        if (!(d.y0 > 20) || Math.abs(d.x0) > 1) v.push(`k1 → ${below}: the new content doesn't start below (x ${d.x0}, y ${d.y0})`);
        const u = await page(SLIDE("k1")); console.log(`        ${below} → k1 (a row above): ${J(u)}`);
        if (u.live !== "slide-above" || u.exit !== "to-bottom") v.push(`${below} → k1 (row above): live ${u.live}, exit ${u.exit} — expected slide-above / to-bottom`);
        if (!(u.y0 < -20)) v.push(`${below} → k1: the new content doesn't start above (y ${u.y0})`);
      }
      win.setContentSize(1400, 900); await sleep(300);
      await setMotion(false);
      await page(`await m.closeAll(); await m.openSide("k1"); await m.sleep(300);`);
      const c = await page(SLIDE("k3")); console.log(`        motion off, k1 → k3: ${J(c)}`);
      if (c.exit !== "fade" || Math.abs(c.x0 ?? 99) > 0.5 || Math.abs(c.y0 ?? 99) > 0.5) v.push(`motion off: the switch didn't cross-fade in place (${J(c)})`);
      if (c.goneAt == null || c.goneAt > 400) v.push(`motion off: the outgoing copy stayed (${c.goneAt} ms)`);
      await setMotion(true);
      await page(`await m.closeAll();`);
      return v;
    });

    await cell("lib:play", async () => {
      const v = [];
      await post("/apply", { path: K[0] }); await sleep(1500);
      await page(`await m.closeAll(); await m.openSide("k3"); await m.sleep(600);`);
      const r0 = await page(`const s = m.side(); const b = s.querySelector("[data-side-play]"); const f = s.querySelector("[data-side-media]");
        return { btn: !!b, inMedia: !!b?.closest("[data-side-media]"), tag: b?.tagName, label: b?.getAttribute("aria-label"), tab: b ? b.tabIndex : null, media: f ? m.rect(f) : null,
          old: [...s.querySelectorAll("button")].filter((x) => /^(Play|Playing|In playlist|Add to playlist)$/.test(x.textContent.trim())).length,
          icon: b ? b.querySelectorAll("svg, img").length : null, bg: b ? getComputedStyle(b).backgroundImage : null, pl: s.querySelector(".side-head [data-side-playlist]")?.getAttribute("aria-pressed") ?? null };`);
      if (!r0.btn || !r0.inMedia) return [`no Play control on k3's picture (${JSON.stringify(r0)})`];
      if (r0.label !== "Play k3") v.push(`its accessible name is "${r0.label}", not "Play k3"`);
      if (r0.tag !== "BUTTON" || r0.tab < 0) v.push(`it isn't keyboard-reachable (${r0.tag}, tabIndex ${r0.tab})`);
      if (r0.old) v.push(`the old Play / In playlist buttons are still there (${r0.old})`);
      // no playlist toggle in the head: the title takes the room
      if (r0.pl !== null) v.push(`the head still has a playlist toggle (aria-pressed=${r0.pl})`);
      if (r0.icon || (r0.bg && r0.bg !== "none")) v.push(`the picture shows a Play icon / tint (owner: no icon; ${r0.icon} icons, bg ${r0.bg})`);
      const cx = r0.media.x + r0.media.w / 2, cy = r0.media.y + r0.media.h / 2;
      await mv(cx - 20, cy, 80); await mv(cx, cy, 500);
      const r1 = await page(`const s = m.side(); const b = s.querySelector("[data-side-play]"); return { icon: b.querySelectorAll("svg, img").length, tr: getComputedStyle(s.querySelector(".side-stage")).transform };`);
      if (r1.icon) v.push(`hovering the picture: a Play icon appears (owner: no icon)`);
      if (r1.tr === "none") v.push("hovering the picture: it doesn't scale");
      await shot("lib-play-hover");
      send({ type: "mouseDown", x: Math.round(cx), y: Math.round(cy), button: "left", clickCount: 1 }); await sleep(40);
      send({ type: "mouseUp", x: Math.round(cx), y: Math.round(cy), button: "left", clickCount: 1 });
      let cur = null; for (let i = 0; i < 50 && (cur = await current()) !== K[2]; i++) await sleep(100);
      if (cur !== K[2]) v.push(`a click on the picture didn't play k3 (/current ${T(cur)})`);
      let r2 = null;
      // playing → the green frame only (no "Playing now" pill — the card and the frame say it);
      // "looping this one" is a hero chip, shown only while loop-current is on
      for (let i = 0; i < 30; i++) { r2 = await page(`const s = m.side(); const f = s.querySelector(".side-stage");
          return { play: !!s.querySelector("[data-side-play]"), frame: !!f?.matches(".is-playing[data-side-playing]"),
            pill: !!s.querySelector("[data-side-media] .side-badge, [data-side-media] [data-side-playing]") || /Playing now/.test(s.querySelector("[data-side-media]")?.textContent ?? ""),
            looping: !!s.querySelector("[data-side-looping]") };`); if (r2.frame) break; await sleep(100); }
      if (!r2.frame) v.push(`playing: the picture's frame isn't marked playing (${JSON.stringify(r2)})`);
      if (r2.pill) v.push(`playing: a "Playing now" pill is back on the picture (${JSON.stringify(r2)})`);
      if (r2.looping) v.push("playing (not looping): a Looping chip shows");
      // loop-current on → the chip shows; off again → gone. Only a rotating playlist can loop-current (a lone wallpaper
      // already stays: the backend answers "no playlist is rotating" and keeps nothing) → k3 first in a playlist
      await post("/playlist/play", { paths: [K[2], K[0]] });
      for (let i = 0; i < 50 && (await current()) !== K[2]; i++) await sleep(100);
      await sleep(800);
      await post("/action", { name: "loop-current" });
      let lp = null; for (let i = 0; i < 30 && !(lp = await page(`return !!m.side().querySelector("[data-side-looping]");`)); i++) await sleep(100);
      await post("/action", { name: "loop-current" });
      if (!lp) v.push("loop-current on: no Looping chip in the sidebar's hero");
      let gone = false; for (let i = 0; i < 30 && !(gone = await page(`return !m.side().querySelector("[data-side-looping]");`)); i++) await sleep(100);
      if (!gone) v.push("loop-current off again: the Looping chip stays");
      await post("/apply", { path: K[2] }); await sleep(800); // back to a lone wallpaper for the cells after
      if (r2.play) v.push("playing: the Play overlay is still there");
      // the title takes the head's width (only close beside it)
      const hd = await page(`const h = m.side().querySelector(".side-head"); return { tools: h.querySelectorAll(".side-head-tools > *").length, textW: Math.round(h.querySelector(".side-head-text").getBoundingClientRect().width), headW: Math.round(h.getBoundingClientRect().width) };`);
      if (hd.tools !== 0 || hd.headW - hd.textW > 80) v.push(`the title doesn't take the head's free width (${JSON.stringify(hd)})`);
      await mv(5, 5);
      await post("/playlist/state", { videoPaths: K.slice(0, 4), settings: null, name: null });
      await post("/apply", { path: K[0] }); await sleep(1200);
      return v;
    });

    // the picture's preview switch: gif / video / YouTube trailer / still (docs/decisions.md § "Open previews on the gif or
    // still, never the video, and remember the pick per sidebar")
    await cell("lib:preview", async () => {
      const v = [];
      // s1 gets a YouTube trailer (its index entry); the embed never reaches the network (no network in the stack anyway)
      const idx = path.join(path.dirname(SC[0]), "index.json"), idx0 = fs.readFileSync(idx, "utf8");
      const j = JSON.parse(idx0); j["900000001"].youtubeUrl = "https://www.youtube.com/watch?v=aqz-KE-bpKQ"; fs.writeFileSync(idx, JSON.stringify(j));
      win.webContents.session.webRequest.onBeforeRequest({ urls: ["*://*.youtube.com/*", "*://*.ytimg.com/*", "*://*.googlevideo.com/*", "*://*.youtube-nocookie.com/*"] }, (d, cb) => cb({ cancel: true }));
      try {
        // the first preview ever: nothing saved
        await page(`for (const k of ${PV_KEYS}) localStorage.removeItem(k);`);
        await loadUi();
        const look = (t) => page(`await m.closeAll(); await m.openSide(${JSON.stringify(t)}); await m.sleep(700); const s = m.side();
          const lay = {}; for (const e of s.querySelectorAll("[data-preview-layer]")) lay[e.dataset.previewLayer] = +m.op(e).toFixed(2);
          const sw = s.querySelector('[role="radiogroup"][aria-label="Preview"]'), md = s.querySelector("[data-side-media]");
          const above = sw && md ? sw.getBoundingClientRect().bottom <= md.getBoundingClientRect().top + 0.5 && !md.contains(sw) : null;
          return { opts: [...s.querySelectorAll("[data-preview-src]")].map((b) => b.dataset.previewSrc), mode: md?.dataset.previewMode, lay, above };`);
        const pick = (k) => page(`m.side().querySelector('[data-preview-src="${k}"]').click(); await m.sleep(700); const s = m.side();
          const lay = {}; for (const e of s.querySelectorAll("[data-preview-layer]")) lay[e.dataset.previewLayer] = +m.op(e).toFixed(2);
          const f = s.querySelector("iframe"); return { mode: s.querySelector("[data-side-media]")?.dataset.previewMode, lay, yt: f?.src ?? null,
            headPlay: !!s.querySelector(".side-head [data-side-play]"), picPlay: !!s.querySelector("[data-side-media] [data-side-play]") };`);
        const J = JSON.stringify;
        let r = await look("k1");
        if (J(r.opts) !== J(["gif", "video"])) v.push(`k1 (a gif + its video): options ${J(r.opts)}`);
        // the switch is a strip attached above the preview, not an overlay
        if (r.above !== true) v.push(`k1: the preview switch isn't above the picture (it overlaps / sits inside it: ${r.above})`);
        if (r.mode !== "gif" || !(r.lay.gif > 0.9)) v.push(`k1 opens on ${r.mode} (layers ${J(r.lay)}), expected the gif`);
        if (r.opts.includes("video")) {
          const p = await pick("video");
          if (p.mode !== "video" || !(p.lay.video > 0.9) || !(p.lay.gif < 0.1)) v.push(`k1 → Video: mode ${p.mode}, layers ${J(p.lay)}`);
          // the frame takes the video's own shape (a 16:9 video must not be cropped into a square picture's frame)
          const sh = await page(`const s = m.side(), f = s.querySelector(".side-frame"), vd = s.querySelector('video[data-preview-layer="video"]'), r = f.getBoundingClientRect();
            return { shape: +f.dataset.shape, box: r.width / r.height, video: vd && vd.videoHeight ? vd.videoWidth / vd.videoHeight : null };`);
          console.log(`        Video shape: ${J(sh)}`);
          if (!sh.video || Math.abs(sh.shape - sh.video) > 0.01 || Math.abs(sh.box - sh.video) > 0.03) v.push(`k1 → Video: the frame (${sh.box.toFixed(3)}) isn't the video's own shape (${sh.video})`);
          // the Video preview's mute button — muted by default; the button toggles the preview's
          // sound and never applies the wallpaper. (Silent either way: the stack's audio is private, and the volume is 0 first.)
          const cur0 = await current();
          const mu = await page(`const s = m.side(), b = s.querySelector("[data-side-mute]"), vd = s.querySelector('video[data-preview-layer="video"]');
            if (!b || !vd) return { btn: !!b, video: !!vd };
            const before = { muted: vd.muted, pressed: b.getAttribute("aria-pressed") };
            vd.volume = 0; b.click(); await m.sleep(250);
            const on = { muted: vd.muted, pressed: s.querySelector("[data-side-mute]").getAttribute("aria-pressed") };
            s.querySelector("[data-side-mute]").click(); await m.sleep(250);
            return { btn: true, video: true, before, on, after: { muted: vd.muted } };`);
          console.log(`        mute: ${JSON.stringify(mu)}`);
          if (!mu.btn) v.push(`Video: no mute button (${JSON.stringify(mu)})`);
          else {
            if (!mu.before.muted || mu.before.pressed !== "false") v.push(`Video: the preview doesn't start muted (${JSON.stringify(mu.before)})`);
            if (mu.on.muted || mu.on.pressed !== "true") v.push(`Video: the button didn't unmute it (${JSON.stringify(mu.on)})`);
            if (!mu.after.muted) v.push("Video: the button didn't mute it again");
          }
          if ((await current()) !== cur0) v.push("Video: the mute button applied the wallpaper");
          await shot("lib-preview-video");
        }
        r = await look("k2");
        // never the video by default — no gif → it opens on the still, Video to pick
        if (J(r.opts) !== J(["image", "video"])) v.push(`k2 (a still + its video): options ${J(r.opts)}, expected [image, video]`);
        if (r.mode !== "video") v.push(`k2 after picking Video on k1: opened on ${r.mode} (the session's pick applies when it has it)`);
        r = await look("k1");
        if (r.mode !== "video") v.push(`back on k1 after picking Video: it opened on ${r.mode} (the pick is kept for the session)`);
        if (r.opts.includes("gif")) {
          await pick("gif");
          const g = await page(`const f = m.side().querySelector(".side-frame"), r = f.getBoundingClientRect(), i = m.side().querySelector('img[data-preview-layer="image"]');
            return { box: r.width / r.height, pic: i && i.naturalHeight ? i.naturalWidth / i.naturalHeight : null };`);
          if (g.pic && Math.abs(g.box - g.pic) > 0.03) v.push(`k1 back on GIF: the frame (${g.box.toFixed(3)}) isn't the picture's shape (${g.pic.toFixed(3)})`);
        }
        r = await look("k2");
        if (r.mode !== "image" || r.lay.video > 0.1) v.push(`k2 with GIF picked last: opened on ${r.mode} (layers ${J(r.lay)}), expected the still, no video`);
        r = await look("s2");
        if (r.opts.length) v.push(`s2 (a scene, no trailer): a switch ${J(r.opts)}`);
        r = await look("s1");
        if (J(r.opts) !== J(["image", "youtube"])) v.push(`s1 (a scene with a trailer): options ${J(r.opts)}, expected [image, youtube]`);
        if (r.opts.includes("youtube")) {
          const p = await pick("youtube");
          if (p.mode !== "youtube" || !p.yt || !/youtube\.com\/embed\//.test(p.yt)) v.push(`s1 → YouTube: no embed (${J(p)})`);
          else if (!/[?&]mute=1/.test(p.yt)) v.push(`the YouTube embed isn't muted (${p.yt})`);
          if (!(p.lay.youtube > 0.5)) v.push(`the YouTube layer isn't shown (${J(p.lay)})`);
          // no Play in the head even on the trailer, and the trailer has no close button of its own
          if (p.headPlay || p.picPlay) v.push(`on the trailer: a Play button shows (head ${p.headPlay}, picture ${p.picPlay})`);
          if (await page(`return !!m.side().querySelector(".yt-close, .yt-stage button");`)) v.push("the trailer has a close button");
          await shot("lib-preview-youtube");
          // the trailer REMEMBERS its mute + volume (YouTube's embed messages; faked here — no network)
          const ym = await page(`const s = m.side(), f = s.querySelector("iframe"); if (!f) return null;
            const say = (info) => window.dispatchEvent(new MessageEvent("message", { origin: "https://www.youtube.com", source: f.contentWindow, data: JSON.stringify({ event: "infoDelivery", info }) }));
            const out = { src: f.src };
            // its volume is the previews' shared level (sidePreview.ts): nothing set yet → s1's wallpaper volume; the player
            // first answers at that level, then moves
            const P = ${await wallOf("s1")};
            say({ muted: false, volume: P }); await m.sleep(50); say({ muted: false, volume: 40 }); await m.sleep(50);
            out.saved = { muted: localStorage.getItem("liascape.previewMuted"), volume: localStorage.getItem("liascape.previewVolume") };
            // a message from anywhere else never counts
            window.dispatchEvent(new MessageEvent("message", { origin: "https://evil.example", source: f.contentWindow, data: JSON.stringify({ event: "infoDelivery", info: { muted: true } }) }));
            await m.sleep(50); out.foreign = localStorage.getItem("liascape.previewMuted");
            window.dispatchEvent(new MessageEvent("message", { origin: "https://www.youtube.com", source: f.contentWindow, data: JSON.stringify({ event: "onStateChange", info: 0 }) }));
            await m.sleep(50); out.loops = f.parentElement.dataset.ytLoops ?? null;
            return out;`);
          console.log(`        trailer memory: ${JSON.stringify(ym)}`);
          if (!ym) v.push("YouTube: no iframe");
          else {
            if (!/[?&]enablejsapi=1/.test(ym.src)) v.push(`the trailer can't report its state (no enablejsapi: ${ym.src})`);
            // it loops at its REAL end — we restart it on the player's "ended", not YouTube's playlist loop, which restarts
            // early (docs/decisions.md § "Loop trailers on the player's "ended", not YouTube's `loop=1`")
            if (/[?&](loop|playlist)=/.test(ym.src)) v.push(`the trailer still uses YouTube's own loop (it restarts early: ${ym.src})`);
            if (ym.loops !== "1") v.push(`the player's "ended" didn't restart the trailer (data-yt-loops ${ym.loops})`);
            if (ym.saved.muted !== "0" || ym.saved.volume !== "40") v.push(`the trailer's unmute / volume 40 wasn't remembered (${JSON.stringify(ym.saved)})`);
            if (ym.foreign !== "0") v.push("a message from another origin changed the remembered mute");
          }
          // the next trailer opens unmuted, and its first (default-100) report doesn't overwrite the saved 40
          await pick("image"); await pick("youtube");
          const y2 = await page(`const f = m.side().querySelector("iframe"); if (!f) return null;
            const say = (info) => window.dispatchEvent(new MessageEvent("message", { origin: "https://www.youtube.com", source: f.contentWindow, data: JSON.stringify({ event: "infoDelivery", info }) }));
            const out = { src: f.src }; say({ muted: false, volume: 100 }); await m.sleep(50); out.afterDefault = localStorage.getItem("liascape.previewVolume");
            say({ muted: false, volume: 40 }); await m.sleep(50); say({ muted: false, volume: 55 }); await m.sleep(50); out.afterMove = localStorage.getItem("liascape.previewVolume");
            for (const k of ${PV_KEYS}) localStorage.removeItem(k); return out;`);
          console.log(`        next trailer: ${JSON.stringify(y2)}`);
          if (y2) {
            if (!/[?&]mute=0/.test(y2.src)) v.push(`the next trailer didn't open unmuted (${y2.src})`);
            if (y2.afterDefault !== "40") v.push(`the player's default-100 report overwrote the saved volume (${y2.afterDefault})`);
            if (y2.afterMove !== "55") v.push(`a volume change after the restore wasn't remembered (${y2.afterMove})`);
          }
          const q = await pick("image");
          if (q.yt) v.push("Picture: the YouTube embed is still mounted");
          if (q.mode !== "image") v.push(`s1 → Picture: mode ${q.mode}`);
        }
      } finally {
        fs.writeFileSync(idx, idx0);
        win.webContents.session.webRequest.onBeforeRequest(null);
        await page(`await m.closeAll();`); await loadUi();
      }
      return v;
    });

    // the Video preview's own volume (components/SidePanel.tsx PreviewVolume, sidePreview.ts previewSound): a slider beside
    // the mute chip; it sets the <video>'s volume and nothing else (not the global volume, not the item's, not the wallpaper);
    // until moved it plays at the item's wallpaper volume; the mute and the level are remembered across items and a reload;
    // mute and level compose; wheel and keys drive it. (The stack's audio is private.)
    const openVideo = async (t) => page(`await m.closeAll(); await m.openSide(${JSON.stringify(t)}); await m.sleep(300);
      const b = m.side().querySelector('[data-preview-src="video"]'); if (b && b.getAttribute("aria-checked") !== "true") b.click();
      for (let i = 0; i < 60 && !m.side().querySelector("[data-side-mute]"); i++) await m.sleep(50); await m.sleep(200); return !!m.side().querySelector("[data-side-mute]");`);
    const VS = `const s = m.side(), vd = s.querySelector('video[data-preview-layer="video"]'), b = s.querySelector("[data-side-mute]"), rg = s.querySelector("[data-side-vol-range]");
      const st = () => ({ muted: vd?.muted, vol: vd ? Math.round(vd.volume * 100) : null, pressed: s.querySelector("[data-side-mute]")?.getAttribute("aria-pressed"),
        x: !!s.querySelector("[data-side-mute] svg.lucide-volume-x"), slider: rg ? +rg.value : null, saved: localStorage.getItem("liascape.previewVolume") });`;
    await cell("preview:volume", async () => {
      const v = [], J = JSON.stringify;
      const g0 = (await getSettings()).volume;
      // k1 has its own wallpaper volume (35), k2 plays at the global (70): the preview's untouched level is the item's
      await setSettings({ volume: 70 }); await post("/library/volume", { path: K[0], intValue: 35 });
      try {
        await page(`for (const k of ${PV_KEYS}) localStorage.removeItem(k);`); await loadUi();
        const set0 = await getSettings(), item0 = await libItem(K[0]), cur0 = await current();
        if (!await openVideo("k1")) return ["k1: the Video preview has no mute chip (proved nothing)"];
        const r = await page(`${VS} if (!rg) return { none: true, first: st() };
          const out = { first: st() };
          b.click(); await m.sleep(150); out.unmuted = st();
          m.setValue(rg, 30); await m.sleep(150); out.at30 = st();
          m.setValue(rg, 0); await m.sleep(150); out.at0 = st();
          s.querySelector("[data-side-mute]").click(); await m.sleep(150); out.restored = st();
          s.querySelector("[data-side-mute]").click(); await m.sleep(150); out.muted = st();
          s.querySelector("[data-side-mute]").click(); await m.sleep(150);
          const wheel = (el, dy) => { const e = new WheelEvent("wheel", { deltaY: dy, deltaMode: 0, bubbles: true, cancelable: true }); el.dispatchEvent(e); return e.defaultPrevented; };
          const sc = s.querySelector(".side-scroll"), top0 = sc.scrollTop;
          out.wheelPrevented = wheel(s.querySelector("[data-side-mute]"), -120); await m.sleep(120); out.wheelUp = st();
          wheel(s.querySelector("[data-side-vol-range]"), 120); wheel(s.querySelector("[data-side-vol-range]"), 120); await m.sleep(120); out.wheelDown = st();
          out.scrolled = sc.scrollTop !== top0;
          // muted, a wheel up starts from the 0 it shows and unmutes
          s.querySelector("[data-side-mute]").click(); await m.sleep(120); wheel(s.querySelector("[data-side-mute]"), -120); await m.sleep(120); out.wheelFromMuted = st();
          m.setValue(rg, 40); await m.sleep(150); out.at40 = st();
          return out;`);
        console.log(`        ${J(r)}`);
        if (r.none) return [`no volume slider beside the mute chip (${J(r.first)})`];
        if (!r.first.muted || r.first.pressed !== "false" || !r.first.x || r.first.slider !== 0) v.push(`opens muted, the slider at 0, the muted glyph: ${J(r.first)}`);
        if (r.unmuted.muted || r.unmuted.vol !== 35 || r.unmuted.slider !== 35 || r.unmuted.x || r.unmuted.saved !== null) v.push(`unmute: plays at k1's own wallpaper volume 35 (nothing saved) with the sound glyph (${J(r.unmuted)})`);
        if (r.at30.vol !== 30 || r.at30.muted || r.at30.saved !== "30") v.push(`slider → 30: the video's volume / the saved level (${J(r.at30)})`);
        if (!r.at0.x || r.at0.pressed !== "false" || !r.at0.muted) v.push(`slider → 0: not shown / played as muted (${J(r.at0)})`);
        if (r.restored.vol !== 30 || r.restored.muted || r.restored.slider !== 30 || r.restored.x) v.push(`unmute after dragging to 0: the last level 30 isn't back (${J(r.restored)})`);
        if (!r.muted.muted || r.muted.slider !== 0 || r.muted.saved !== "30" || !r.muted.x) v.push(`mute: silent, slider 0, the level kept at 30 (${J(r.muted)})`);
        if (!r.wheelPrevented || r.scrolled) v.push(`the wheel over the control scrolls the sidebar (prevented ${r.wheelPrevented}, scrolled ${r.scrolled})`);
        if (r.wheelUp.slider !== 35 || r.wheelUp.vol !== 35) v.push(`a wheel notch up: 30 → ${r.wheelUp.slider} (want 35)`);
        if (r.wheelDown.slider !== 25) v.push(`two notches down: 35 → ${r.wheelDown.slider} (want 25)`);
        if (r.wheelFromMuted.muted || r.wheelFromMuted.slider !== 5) v.push(`muted + a notch up: ${J(r.wheelFromMuted)} (want unmuted at 5)`);
        if (r.at40.vol !== 40) v.push(`slider → 40: video at ${r.at40.vol}`);
        // keyboard: Tab from the chip lands on the slider (shown), arrows step it, the grid's arrows don't fire
        const box = await page(`const b = m.side().querySelector("[data-side-mute]"); b.focus(); return m.rect(b);`);
        const key = async (k) => { send({ type: "keyDown", keyCode: k }); await sleep(30); send({ type: "keyUp", keyCode: k }); await sleep(120); };
        await key("Tab"); await sleep(400);
        const kb0 = await page(`const a = document.activeElement, sl = m.side().querySelector(".side-vol-slide");
          return { onRange: a?.matches?.("[data-side-vol-range]"), op: +getComputedStyle(sl).opacity, title: m.sideTitle() };`);
        await key("Right"); await key("Right"); await key("Left"); await key("Right");
        const kb = await page(`${VS} return { ...st(), title: m.sideTitle(), focused: document.querySelector(".card.focused .lib-title")?.dataset.title ?? null };`);
        await key("Home");
        const kbH = await page(`${VS} return st();`);
        await key("End"); await sleep(50);
        await page(`${VS} m.setValue(rg, 40);`); await sleep(150);
        console.log(`        keys: ${J({ box, kb0, kb, kbH })}`);
        if (!kb0.onRange) v.push("Tab from the mute chip doesn't reach the volume slider");
        if (!(kb0.op > 0.95)) v.push(`the slider has keyboard focus but isn't shown (opacity ${kb0.op})`);
        if (kb.slider !== 42 || kb.vol !== 42) v.push(`arrows on the slider: 40 → ${kb.slider} (want 42)`);
        if (kb.title !== "k1" || kb.focused !== "k1") v.push(`the arrows moved the grid's focus (sidebar ${kb.title}, focused card ${kb.focused})`);
        if (kbH.slider !== 0 || !kbH.x) v.push(`Home: ${J(kbH)} (want 0, the muted glyph)`);
        // the mute and the level are remembered across items and a reload (k2's own wallpaper volume is the global 70, so 40
        // is the preview's); never the global / the item's volume; nothing applied
        if (!await openVideo("k2")) v.push("k2: no Video preview");
        else {
          const k2 = await page(`${VS} const out = { first: st() }; b.click(); await m.sleep(150); out.muted = st(); return out;`);
          if (k2.first.muted || k2.first.pressed !== "true" || k2.first.vol !== 40 || k2.first.slider !== 40) v.push(`k2 (left unmuted at 40 on k1): opens ${J(k2.first)}, want unmuted at the remembered 40`);
          if (!k2.muted.muted || k2.muted.slider !== 0) v.push(`k2: the chip didn't mute it (${J(k2.muted)})`);
        }
        await page(`await m.closeAll();`); await loadUi();
        if (!await openVideo("k1")) v.push("after a reload: no Video preview");
        else {
          const rl = await page(`${VS} const o = { first: st() }; b.click(); await m.sleep(150); o.unmuted = st(); s.querySelector("[data-side-mute]").click(); return o;`);
          if (!rl.first.muted || rl.first.slider !== 0) v.push(`after a reload: k1 doesn't open muted as it was left (${J(rl.first)})`);
          if (rl.unmuted.vol !== 40 || rl.unmuted.slider !== 40) v.push(`after a reload, unmuted: ${J(rl.unmuted)} (want the remembered 40)`);
        }
        const set1 = await getSettings(), item1 = await libItem(K[0]);
        if (set1.volume !== set0.volume || set1.noAudio !== set0.noAudio) v.push(`the global volume changed (${set0.volume}/${set0.noAudio} → ${set1.volume}/${set1.noAudio})`);
        if (item1?.volumeOverride !== item0?.volumeOverride) v.push(`k1's own volume changed (${item0?.volumeOverride} → ${item1?.volumeOverride})`);
        if ((await current()) !== cur0) v.push("the volume control applied a wallpaper");
      } finally {
        await page(`await m.closeAll(); for (const k of ${PV_KEYS}) localStorage.removeItem(k);`);
        await setSettings({ volume: g0 }); await post("/library/volume", { path: K[0], intValue: null });
      }
      return v;
    });

    // the notch sits at the item's wallpaper volume; a level moved to within a few points of it snaps on and the preview
    // follows the wallpaper again (nothing saved); a small step that starts on or inside the band leaves it (arrow keys
    // aren't swallowed by the snap). SidePanel.tsx snapsToWallpaper.
    await cell("preview:notch", async () => {
      const v = [], J = JSON.stringify;
      await post("/library/volume", { path: K[0], intValue: 35 });
      try {
        await page(`for (const k of ${PV_KEYS}) localStorage.removeItem(k);`); await loadUi();
        if (!await openVideo("k1")) return ["k1: the Video preview has no mute chip (proved nothing)"];
        const NS = `${VS} const now = () => { const n = m.side().querySelector(".side-vol-notch");
          return { ...st(), on: !!n?.classList.contains("on"), at: n ? +getComputedStyle(n).getPropertyValue("--at") : null }; };`;
        const r = await page(`${NS} if (!rg) return { none: true };
          const o = {}; b.click(); await m.sleep(150); o.start = now();
          for (const [k, x] of [["at60", 60], ["near", 37], ["at10", 10], ["below", 33], ["out", 39], ["back", 36]]) {
            m.setValue(m.side().querySelector("[data-side-vol-range]"), x); await m.sleep(150); o[k] = now(); }
          return o;`);
        console.log(`        ${J(r)}`);
        if (r.none) return ["no volume slider (proved nothing)"];
        if (!r.start.on || r.start.slider !== 35) return [`unmuted, k1 doesn't start on its notch at 35 (${J(r.start)}) — proved nothing`];
        if (Math.abs(r.start.at - 0.35) > 0.005) v.push(`the notch sits at ${r.start.at}, not k1's 35`);
        const on = (x, n) => x.on && x.slider === 35 && x.vol === 35 && x.saved === null || v.push(`${n}: want snapped onto the notch (35, following, nothing saved): ${J(x)}`);
        const off = (x, n, want) => (!x.on && x.slider === want && x.saved === String(want)) || v.push(`${n}: want its own level ${want}, off the notch: ${J(x)}`);
        off(r.at60, "60", 60); on(r.near, "60 → 37"); off(r.at10, "10", 10); on(r.below, "10 → 33");
        off(r.out, "35 → 39 (outside the band)", 39); on(r.back, "39 → 36");
        // keys: one step off the notch leaves it, the next step inside the band stays where it is, back down to 35 lands on it
        const key = async (k) => { send({ type: "keyDown", keyCode: k }); await sleep(30); send({ type: "keyUp", keyCode: k }); await sleep(150); };
        await page(`m.side().querySelector("[data-side-vol-range]").focus();`);
        const ks = [];
        for (const k of ["Right", "Right", "Left", "Left"]) { await key(k); ks.push(await page(`${NS} return now();`)); }
        console.log(`        keys: ${J(ks)}`);
        off(ks[0], "notch + Right", 36); off(ks[1], "36 + Right", 37); off(ks[2], "37 + Left", 36); on(ks[3], "36 + Left");
      } finally {
        await page(`await m.closeAll(); for (const k of ${PV_KEYS}) localStorage.removeItem(k);`);
        await post("/library/volume", { path: K[0], intValue: null });
      }
      return v;
    });

    // its look: the pill slides + fades out from under the chip on hover (per frame, transform + opacity), instant with motion
    // off; hidden it takes no pointer; it stays inside the picture; the chip's glow goes under no-glow; the pill keeps its own
    // dark fill under bg-live. Screenshots side-pvol-*.png.
    await cell("look:previewVolume", async () => {
      const v = [], J = JSON.stringify;
      const reveal = async () => {
        if (!await openVideo("k1")) return null;
        const b = await page(`const b = m.side().querySelector("[data-side-mute]"); return b ? m.rect(b) : null;`);
        if (!b) return { none: true };
        await mv(5, 5, 300);
        const hid = await page(`const sl = m.side().querySelector(".side-vol-slide"); if (!sl) return null; const c = getComputedStyle(sl); return { op: +c.opacity, pe: c.pointerEvents };`);
        if (!hid) return { none: true };
        const samp = page(`const sl = m.side().querySelector(".side-vol-slide"); const out = []; const t0 = performance.now();
          await new Promise((res) => { const f = () => { const c = getComputedStyle(sl); out.push({ op: +(+c.opacity).toFixed(3), tx: new DOMMatrixReadOnly(c.transform === "none" ? undefined : c.transform).m41 });
            if (performance.now() - t0 < 700) requestAnimationFrame(f); else res(); }; requestAnimationFrame(f); }); return out;`);
        await sleep(30); await mv(b.x + b.w / 2, b.y + b.h / 2);
        const frames = await samp;
        const geo = await page(`const s = m.side(), sl = s.querySelector(".side-vol-slide"), md = s.querySelector("[data-side-media]"), rg = s.querySelector("[data-side-vol-range]");
          const a = m.rect(sl), p = m.rect(md), c = getComputedStyle(sl), cb = getComputedStyle(s.querySelector("[data-side-mute]"));
          return { sl: a, md: p, inside: a.x >= p.x - 0.5 && a.x + a.w <= p.x + p.w + 0.5 && a.y >= p.y - 0.5 && a.y + a.h <= p.y + p.h + 0.5,
            bg: c.backgroundColor, color: c.color, text: (() => { const d = document.createElement("div"); d.style.color = "var(--text)"; document.body.appendChild(d); const x = getComputedStyle(d).color; d.remove(); return x; })(),
            fill: rg?.style.getPropertyValue("--fill"), chipShadow: cb.boxShadow, pe: c.pointerEvents };`);
        return { hid, frames, geo, b };
      };
      try {
        await loadUi(); await setMotion(true);
        const on = await reveal();
        if (!on) return ["k1: no Video preview (proved nothing)"];
        if (on.none) return ["no volume control beside the mute chip"];
        const mid = on.frames.filter((f) => f.op > 0.02 && f.op < 0.98).length, last = on.frames[on.frames.length - 1];
        console.log(`        motion on: hidden ${J(on.hid)}, ${on.frames.length} frames, ${mid} between, last ${J(last)}; ${J(on.geo)}`);
        if (!(on.hid.op === 0 && on.hid.pe === "none")) v.push(`not hovered: the slider shows or takes the pointer (${J(on.hid)})`);
        if (mid < 2) v.push(`motion on: the slider popped in (${mid} frames between)`);
        if (!(last.op > 0.98) || Math.abs(last.tx) > 0.5) v.push(`hovered: the slider isn't fully shown in place (${J(last)})`);
        if (!on.geo.inside) v.push(`the slider leaves the picture (${J(on.geo.sl)} vs ${J(on.geo.md)})`);
        if (on.geo.color !== on.geo.text) v.push(`the slider's text isn't the theme's text colour (${on.geo.color} vs ${on.geo.text})`);
        if (!on.geo.fill) v.push("the slider's track has no accent fill (--fill)");
        if (!on.geo.chipShadow || on.geo.chipShadow === "none") v.push("glows on: the hovered chip doesn't glow");
        await shot("pvol-hover");
        await page(`${VS} b.click(); await m.sleep(250); m.setValue(rg, 65); await m.sleep(200);`);
        await shot("pvol-hover-unmuted");
        // no-glow + bg-live while hovered
        const ng = await page(`const root = document.documentElement, s = m.side(); root.classList.add("no-glow"); await m.sleep(300);
          const out = { chip: getComputedStyle(s.querySelector("[data-side-mute]")).boxShadow }; root.classList.remove("no-glow");
          const had = root.classList.contains("bg-live"); root.classList.add("bg-live"); await m.sleep(50); out.bg = getComputedStyle(s.querySelector(".side-vol-slide")).backgroundColor; if (!had) root.classList.remove("bg-live");
          return out;`);
        if (ng.chip !== "none") v.push(`no-glow: the hovered chip still glows (${ng.chip})`);
        const a = /\/\s*([\d.]+)\s*\)/.exec(ng.bg)?.[1] ?? /rgba\([^)]*,\s*([\d.]+)\)/.exec(ng.bg)?.[1] ?? "1";
        if (+a < 0.5) v.push(`bg-live: the slider's pill has no dark fill of its own (${ng.bg})`);
        await page(`document.documentElement.classList.add("no-glow");`); await sleep(250); await shot("pvol-noglow"); await page(`document.documentElement.classList.remove("no-glow");`);
        // a mid-reveal frame for the eye
        await mv(5, 5, 600); const bb = on.b; await mv(bb.x + bb.w / 2, bb.y + bb.h / 2); await sleep(70); await shot("pvol-midreveal"); await sleep(600);
        await page(`${VS} b.click(); await m.sleep(250);`); await shot("pvol-muted");
        await mv(5, 5, 400); await shot("pvol-rest");
        // motion off: it fades in place (opacity only)
        await setMotion(false); await mv(5, 5);
        const off = await reveal();
        if (!off || off.none) v.push("motion off: no control");
        else {
          const mid0 = off.frames.filter((f) => f.op > 0.02 && f.op < 0.98).length, tx0 = off.frames.filter((f) => Math.abs(f.tx) > 0.5 && f.op > 0.02).length;
          console.log(`        motion off: ${mid0} frames between (opacity), ${tx0} (moving)`);
          if (tx0) v.push(`motion off: the slider moves (${tx0} frames off its place)`);
          if (!mid0) v.push("motion off: the slider popped in (no in-between opacity frame)");
          if (Math.abs(off.hid.op) > 0.01) v.push(`motion off: hidden, the slider still shows (${J(off.hid)})`);
        }
      } finally {
        await mv(5, 5); await page(`await m.closeAll(); for (const k of ${PV_KEYS}) localStorage.removeItem(k);`); await setMotion(true);
      }
      return v;
    });

    // a stub YouTube player (no network in the stack): s1 gets a trailer, https://www.youtube.com/embed/* serves a page that
    // echoes every message the app posts to it back as {event: "stub", data} (collected in window.__yt) and answers like the
    // real player's embed messaging: `listening` / a command → infoDelivery {volume, muted, playerState}
    const YT_STUB = `<!doctype html><body style="background:#123"><script>
      let vol = 100, state = 1; const muted = /[?&]mute=1/.test(location.search);
      const say = (o) => parent.postMessage(JSON.stringify(o), "*");
      addEventListener("message", (e) => { let d; try { d = JSON.parse(e.data); } catch { return; }
        say({ event: "stub", data: d });
        if (d.event === "command") { if (d.func === "setVolume") vol = d.args[0]; if (d.func === "pauseVideo") state = 2; if (d.func === "playVideo") state = 1; }
        if (d.event === "listening" || d.event === "command") say({ event: "infoDelivery", info: { volume: vol, muted, playerState: state } }); });
    </script></body>`;
    async function withYtStub(fn) {
      const idx = path.join(path.dirname(SC[0]), "index.json"), idx0 = fs.readFileSync(idx, "utf8");
      const j = JSON.parse(idx0); j["900000001"].youtubeUrl = "https://www.youtube.com/watch?v=aqz-KE-bpKQ"; fs.writeFileSync(idx, JSON.stringify(j));
      const proto = win.webContents.session.protocol;
      proto.handle("https", (req) => new URL(req.url).hostname === "www.youtube.com"
        ? new Response(YT_STUB, { headers: { "Content-Type": "text/html" } }) : new Response("", { status: 404 }));
      try {
        await loadUi();
        await js(`window.__yt = []; window.addEventListener("message", (e) => { if (e.origin !== "https://www.youtube.com") return;
          try { const d = JSON.parse(e.data); if (d.event === "stub") window.__yt.push(d.data); } catch { /* not ours */ } }); true`);
        return await fn();
      } finally {
        fs.writeFileSync(idx, idx0); proto.unhandle("https");
        await page(`await m.closeAll();`); await loadUi();
      }
    }
    // s1's sidebar on its trailer, once the stub player answered (its `listening` arrived and a setVolume was confirmed)
    const openTrailer = () => page(`await m.closeAll(); await m.openSide("s1"); await m.sleep(300);
      const b = m.side().querySelector('[data-preview-src="youtube"]'); if (!b) return false; if (b.getAttribute("aria-checked") !== "true") b.click();
      for (let i = 0; i < 80 && !window.__yt.some((d) => d.event === "listening"); i++) await m.sleep(50);
      await m.sleep(400); return window.__yt.some((d) => d.event === "listening");`);
    const ytCmds = (since = 0) => js(`window.__yt.slice(${since}).filter((d) => d.event === "command").map((d) => d.func + (d.args?.length ? "(" + d.args.join(",") + ")" : ""))`);

    // the previews' level until the user sets one is the item's effective wallpaper volume (sidePreview.ts previewLevel):
    // k1's own, k2's the global; live while the sidebar's Volume row moves; the trailer is told the same level. Once the
    // preview's own slider moves, every item keeps it. (The stack's audio is private.)
    await cell("preview:follow", async () => {
      const v = [], J = JSON.stringify;
      const g0 = (await getSettings()).volume;
      await setSettings({ volume: 70 }); await post("/library/volume", { path: K[0], intValue: 35 });
      try {
        await page(`for (const k of ${PV_KEYS}) localStorage.removeItem(k);`);
        // the trailer first: nothing set → s1's wallpaper volume (the global 70), then live with s1's Volume row
        await withYtStub(async () => {
          if (!await openTrailer()) { v.push("s1: the stub trailer never answered (proved nothing)"); return; }
          const first = await ytCmds();
          const n = (await js(`window.__yt.length`));
          const row = await page(`const r = m.sideRow("volume")?.querySelector("input[type=range]"); if (!r) return false; m.setValue(r, 55); await m.sleep(300); return true;`);
          const moved = await ytCmds(n);
          console.log(`        trailer: ${J({ first, row, moved })}`);
          const vols = (l) => l.filter((c) => c.startsWith("setVolume(")).map((c) => +c.slice(10, -1));
          if (vols(first).at(-1) !== 70) v.push(`the trailer wasn't told s1's wallpaper volume 70 (${J(first)})`);
          if (!row) v.push("s1: no Volume row");
          else if (vols(moved).at(-1) !== 55) v.push(`s1's Volume row → 55: the trailer wasn't told 55 (${J(moved)})`);
          await post("/library/volume", { path: (await libItemByTitle("s1")).videoPath, intValue: null });
        });
        if (!await openVideo("k1")) return [...v, "k1: no Video preview (proved nothing)"];
        const a = await page(`${VS} const out = {}; b.click(); await m.sleep(150); out.k1 = st();
          const row = m.sideRow("volume")?.querySelector("input[type=range]"); if (!row) return { ...out, noRow: true };
          m.setValue(row, 60); await m.sleep(200); out.row60 = st(); return out;`);
        console.log(`        k1: ${J(a)}`);
        if (a.k1.muted || a.k1.vol !== 35 || a.k1.slider !== 35 || a.k1.saved !== null) v.push(`k1 unmuted: ${J(a.k1)}, want its own wallpaper volume 35, nothing saved`);
        if (a.noRow) v.push("k1: no Volume row");
        else if (a.row60.vol !== 60 || a.row60.slider !== 60 || a.row60.saved !== null) v.push(`k1's Volume row → 60: the preview ${J(a.row60)}, want 60 (following, nothing saved)`);
        await sleep(400); // the row's debounced save
        if (!await openVideo("k2")) v.push("k2: no Video preview");
        else {
          const b = await page(`${VS} const out = { first: st() }; m.setValue(rg, 20); await m.sleep(150); out.own = st(); return out;`);
          console.log(`        k2: ${J(b)}`);
          if (b.first.muted || b.first.vol !== 70 || b.first.slider !== 70) v.push(`k2 (no own volume): ${J(b.first)}, want unmuted at the global 70`);
          if (b.own.vol !== 20 || b.own.saved !== "20") v.push(`k2's preview slider → 20: ${J(b.own)}`);
        }
        if (!await openVideo("k1")) v.push("k1 again: no Video preview");
        else {
          const c = await page(`${VS} const out = { first: st() }; const row = m.sideRow("volume")?.querySelector("input[type=range]");
            if (row) { m.setValue(row, 50); await m.sleep(200); } out.row50 = st(); return out;`);
          console.log(`        k1 after the preview's own level: ${J(c)}`);
          if (c.first.vol !== 20 || c.first.slider !== 20) v.push(`k1 after the preview slider moved: ${J(c.first)}, want the preview's own 20 (not k1's 60)`);
          if (c.row50.vol !== 20) v.push(`k1's Volume row → 50 moved the preview's own level (${J(c.row50)})`);
        }
      } finally {
        await page(`await m.closeAll(); for (const k of ${PV_KEYS}) localStorage.removeItem(k);`);
        await setSettings({ volume: g0 }); await post("/library/volume", { path: K[0], intValue: null });
      }
      return v;
    });

    // the Library stays mounted behind another tab (App.tsx <Activity>, hidden): its sidebar's unmuted Video preview and
    // YouTube trailer must not keep sounding there — paused when Browse / Settings shows, playing on (unmuted) back on
    // Library; a trailer the user paused stays paused. (The stack's audio is private; we read paused / muted.)
    await cell("preview:hiddenTab", async () => {
      const v = [], J = JSON.stringify;
      await page(`for (const k of ${PV_KEYS}) localStorage.removeItem(k);`); await loadUi();
      try {
        if (!await openVideo("k1")) return ["k1: no Video preview (proved nothing)"];
        const on = await page(`${VS} b.click(); await m.sleep(500); const t0 = vd.currentTime; await m.sleep(400);
          return { ...st(), paused: vd.paused, adv: +(vd.currentTime - t0).toFixed(2) };`);
        if (on.paused || on.muted || !(on.adv > 0.1)) return [`k1's Video preview isn't playing unmuted before the switch (${J(on)}) — proved nothing`];
        const HID = `const vd = document.querySelector('.side-panel[data-side="library"] video[data-preview-layer="video"]');`;
        // pausedAtHide: read as the commit that hides the Library lands (a MutationObserver runs right after it, before any
        // paint) — paused there, nothing more is heard than before the click
        const away = async (name) => page(`${HID} if (!vd) return null; const side = document.querySelector('.side-panel[data-side="library"]');
          const out = { name: ${J(name)}, pausedAtHide: null };
          const mo = new MutationObserver(() => { if (out.pausedAtHide == null && !side.checkVisibility()) out.pausedAtHide = vd.paused; });
          mo.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["style", "class", "hidden"] });
          m.byText(".tab", ${J(name)}).click();
          await m.sleep(600); mo.disconnect(); const t0 = vd.currentTime; await m.sleep(500);
          return { ...out, paused: vd.paused, muted: vd.muted, adv: +(vd.currentTime - t0).toFixed(2), libHidden: !document.querySelector('.side-panel[data-side="library"]')?.checkVisibility() };`);
        const r1 = await away("Browse"), r2 = await away("Settings");
        await tab("Library"); await sleep(300);
        const back = await page(`${VS} const t0 = vd.currentTime; await m.sleep(500); return { ...st(), paused: vd.paused, adv: +(vd.currentTime - t0).toFixed(2) };`);
        console.log(`        video: ${J({ on, r1, r2, back })}`);
        for (const r of [r1, r2]) {
          if (!r) { v.push("the hidden Library's Video preview is gone (nothing to check)"); continue; }
          if (!r.libHidden) v.push(`${r.name}: the Library sidebar still shows — the switch proved nothing`);
          if (!r.paused || r.adv > 0) v.push(`${r.name} shown: the hidden Library's Video preview keeps playing (${J(r)})`);
          else if (r.pausedAtHide !== true) v.push(`${r.name} shown: the preview was still playing as the Library was hidden (${J(r)})`);
        }
        if (back.paused || !(back.adv > 0.1) || back.muted || back.pressed !== "true") v.push(`back on Library: the Video preview doesn't play on unmuted (${J(back)})`);
        // the trailer: pauseVideo as the page hides, playVideo as it shows; one the user paused stays paused
        await withYtStub(async () => {
          if (!await openTrailer()) { v.push("s1: the stub trailer never answered (proved nothing)"); return; }
          let n = await js(`window.__yt.length`);
          await tab("Settings"); const hid = await ytCmds(n);
          n = await js(`window.__yt.length`); await tab("Library"); await sleep(300); const shown = await ytCmds(n);
          await page(`const f = m.side().querySelector("iframe"); window.dispatchEvent(new MessageEvent("message", { origin: "https://www.youtube.com", source: f.contentWindow,
            data: JSON.stringify({ event: "onStateChange", info: 2 }) })); await m.sleep(100);`);
          n = await js(`window.__yt.length`); await tab("Browse"); const hid2 = await ytCmds(n);
          n = await js(`window.__yt.length`); await tab("Library"); await sleep(300); const shown2 = await ytCmds(n);
          console.log(`        trailer: ${J({ hid, shown, hid2, shown2 })}`);
          if (!hid.includes("pauseVideo") || hid.includes("playVideo")) v.push(`Settings shown: the hidden trailer wasn't paused (${J(hid)})`);
          if (!shown.includes("playVideo")) v.push(`back on Library: the trailer wasn't resumed (${J(shown)})`);
          if (!hid2.includes("pauseVideo")) v.push(`Browse shown: the hidden trailer wasn't paused (${J(hid2)})`);
          if (shown2.includes("playVideo")) v.push(`back on Library: a trailer the user paused was resumed (${J(shown2)})`);
        });
      } finally {
        await page(`await m.closeAll(); for (const k of ${PV_KEYS}) localStorage.removeItem(k);`);
      }
      return v;
    });

    // the preview switch: the segmented control's strip fused to the picture's top edge (components/SidePanel.tsx SideMedia,
    // components/Segmented.tsx). k2 gets a trailer so it offers all three (still, video, YouTube); s2 has one option.
    for (const [W, H] of [[1920, 1080], [1100, 700]]) {
      await cell(`look:strip:${W}x${H}`, async () => {
        const v = [], J = JSON.stringify, tag = `${W}x${H}`;
        win.setContentSize(W, H);
        let fit = false, got = null; for (let i = 0; i < 60 && !fit; i++) { got = await js(`[innerWidth, innerHeight]`); fit = Math.abs(got[0] - W) <= 4 && Math.abs(got[1] - H) <= 4; if (!fit) await sleep(50); }
        console.log(`        window ${got.join("x")}`); // (the private Xvfb has no window manager: a few px off the asked size)
        if (!fit) { win.setContentSize(1400, 900); return [`the window is ${got.join("x")}, not ${tag} — run with LIASCAPE_MATRIX_SCREEN=2560x1440 (proved nothing)`]; }
        const INDEX = path.join(path.dirname(path.dirname(K[1])), "index.json"), idx0 = fs.readFileSync(INDEX, "utf8");
        const j = JSON.parse(idx0); j[path.basename(path.dirname(K[1]))].youtubeUrl = "https://www.youtube.com/watch?v=aqz-KE-bpKQ"; fs.writeFileSync(INDEX, JSON.stringify(j));
        win.webContents.session.webRequest.onBeforeRequest({ urls: ["*://*.youtube.com/*", "*://*.ytimg.com/*", "*://*.googlevideo.com/*", "*://*.youtube-nocookie.com/*"] }, (d, cb) => cb({ cancel: true }));
        const M = () => page(`const s = m.side(), st = s.querySelector(".side-stage"), sw = s.querySelector('[role="radiogroup"][aria-label="Preview"]');
          const md = s.querySelector("[data-side-media]"), gl = s.querySelector(".side-glow"), ct = s.querySelector(".side-content"), cs = getComputedStyle(ct);
          const R = (e) => e ? m.rect(e) : null;
          const rad = (e) => { const c = getComputedStyle(e); return [c.borderTopLeftRadius, c.borderTopRightRadius, c.borderBottomRightRadius, c.borderBottomLeftRadius].map(parseFloat); };
          const alpha = (c) => { const a = c.match(/\\/\\s*([\\d.]+)\\s*\\)/) ?? c.match(/rgba\\([^)]*,\\s*([\\d.]+)\\)/); return a ? +a[1] : (c === "transparent" ? 0 : 1); };
          const contentW = ct.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
          const shape = +s.querySelector(".side-frame").dataset.shape;
          const hl = sw?.querySelector(".seg-hl"), on = sw?.querySelector('[aria-checked="true"]');
          return { st: R(st), sw: R(sw), md: R(md), gl: R(gl), contentW, want: Math.min(contentW, Math.min(innerHeight * .38, 320) * shape), shape,
            strip: !!s.querySelector(".seg.strip"), swRad: sw ? rad(sw) : null, mdRad: rad(md), mode: md.dataset.previewMode,
            opts: sw ? [...sw.querySelectorAll("[data-preview-src]")].map((b) => b.dataset.previewSrc) : [], hl: R(hl), on: R(on),
            glOp: +getComputedStyle(gl).opacity, glBs: getComputedStyle(gl).boxShadow, swA: sw ? alpha(getComputedStyle(sw).backgroundColor) : null,
            tr: getComputedStyle(st).transform };`);
        const near = (a, b, t = 0.5) => Math.abs(a - b) <= t;
        // the joined look: one shape, as wide as the content allows, no gap
        const joined = (r, what) => {
          if (!r.strip) v.push(`${what}: the switch isn't the segmented strip (.seg.strip)`);
          if (!r.sw) return;
          const gap = r.md.y - (r.sw.y + r.sw.h);
          if (!near(gap, 0)) v.push(`${what}: ${gap.toFixed(2)} px between the strip and the picture (want 0)`);
          if (!near(r.sw.x, r.md.x) || !near(r.sw.x + r.sw.w, r.md.x + r.md.w)) v.push(`${what}: the strip (${r.sw.x.toFixed(1)}–${(r.sw.x + r.sw.w).toFixed(1)}) and the picture (${r.md.x.toFixed(1)}–${(r.md.x + r.md.w).toFixed(1)}) don't share their edges`);
          if (!near(r.st.w, r.want, 1)) v.push(`${what}: the unit is ${r.st.w.toFixed(1)} px wide, want ${r.want.toFixed(1)} (content ${r.contentW.toFixed(1)}, shape ${r.shape})`);
          if (!(r.swRad[0] > 4 && r.swRad[1] > 4 && r.swRad[2] === 0 && r.swRad[3] === 0)) v.push(`${what}: the strip's corners ${J(r.swRad)} (rounded top, square bottom)`);
          if (!(r.mdRad[0] === 0 && r.mdRad[1] === 0 && r.mdRad[2] > 4 && r.mdRad[3] > 4)) v.push(`${what}: the picture's corners ${J(r.mdRad)} (square top, rounded bottom)`);
          if (!(r.sw.h >= 18 && r.sw.h <= 24.5)) v.push(`${what}: the strip is ${r.sw.h.toFixed(1)} px tall (a little shorter than the old 25 px pills)`);
          if (!r.hl || !r.on || !near(r.hl.x + r.hl.w / 2, r.on.x + r.on.w / 2, 1) || !near(r.hl.w, r.on.w, 1)) v.push(`${what}: the highlight ${J(r.hl)} isn't on the chosen option ${J(r.on)}`);
          if (!near(r.gl.y, r.sw.y) || !near(r.gl.h, r.st.h) || !near(r.gl.w, r.st.w)) v.push(`${what}: the glow ${J(r.gl)} doesn't wrap the unit ${J(r.st)}`);
        };
        // per-frame x of the strip's highlight across a pick
        const glide = (k) => page(`const sw = m.side().querySelector('[role="radiogroup"][aria-label="Preview"]'), hl = sw?.querySelector(".seg-hl");
          if (!hl) return null; const X = () => new DOMMatrixReadOnly(getComputedStyle(hl).transform === "none" ? undefined : getComputedStyle(hl).transform).m41;
          const x0 = X(); sw.querySelector('[data-preview-src="${k}"]').click(); const xs = []; const t0 = performance.now();
          await new Promise((res) => { const f = () => { xs.push(X()); if (performance.now() - t0 < 700) requestAnimationFrame(f); else res(); }; requestAnimationFrame(f); });
          return { x0, xs };`);
        const between = (g) => { const x1 = g.xs[g.xs.length - 1]; return g.xs.filter((x) => Math.abs(x - g.x0) > 1 && Math.abs(x - x1) > 1).length; };
        try {
          await loadUi(); await setMotion(true); await mv(5, 5);
          await page(`await m.closeAll(); await m.openSide("k2"); await m.sleep(800);`);
          let r = await M();
          if (J(r.opts) !== J(["image", "video", "youtube"])) v.push(`k2 (still + video + trailer): options ${J(r.opts)}`);
          if (r.mode !== "image") await page(`m.side().querySelector('[data-preview-src="image"]')?.click(); await m.sleep(700);`);
          r = await M(); joined(r, "k2 on its still");
          await shot(`strip-${tag}-three`);
          // the whole unit grows while the (playable) picture is hovered — the strip with it
          await mv(r.md.x + r.md.w / 2, r.md.y + r.md.h / 2, 80); await mv(r.md.x + r.md.w / 2 + 2, r.md.y + r.md.h / 2, 500);
          const hv = await M();
          if (hv.tr === "none" || !(hv.sw && hv.sw.w > r.sw.w * 1.015)) v.push(`hovering the picture: the unit doesn't grow (transform ${hv.tr}, strip ${r.sw?.w.toFixed(1)} → ${hv.sw?.w.toFixed(1)})`);
          if (!(hv.glOp > r.glOp)) v.push(`hovering the picture: the glow doesn't brighten (${r.glOp} → ${hv.glOp})`);
          await shot(`strip-${tag}-hover`);
          await mv(5, 5, 400);
          // the highlight glides to YouTube (two options over) on transform, through in-between frames, and lands centred
          const g = await glide("youtube");
          if (!g) v.push("no strip highlight (.seg-hl)");
          else {
            const n = between(g), x1 = g.xs[g.xs.length - 1];
            console.log(`        ${tag} strip highlight ${g.x0.toFixed(1)} → ${x1.toFixed(1)}, ${n} frames between, peak ${Math.max(...g.xs).toFixed(1)}`);
            if (!(x1 > g.x0 + 10)) v.push(`the highlight didn't move to YouTube (${g.x0} → ${x1})`);
            if (n < 3) v.push(`motion on: the highlight jumped (${n} frames between)`);
          }
          await sleep(300);
          r = await M(); joined(r, "k2 on YouTube");
          if (!near(r.st.w, r.contentW, 1)) v.push(`k2 on YouTube (16:9): the unit is ${r.st.w.toFixed(1)} px, not the content's full ${r.contentW.toFixed(1)}`);
          await shot(`strip-${tag}-youtube`);
          // a mid-glide picture (back to the still)
          await page(`m.side().querySelector('[data-preview-src="image"]').click();`); await sleep(110); await shot(`strip-${tag}-midglide`); await sleep(600);
          // glow: wraps the unit; Glow effects off → none; under bg-live the strip keeps its own dark fill
          const ng = await page(`const root = document.documentElement, gl = m.side().querySelector(".side-glow"), sw = m.side().querySelector(".seg.strip");
            root.classList.add("no-glow"); await m.sleep(350); const out = { op: +getComputedStyle(gl).opacity }; root.classList.remove("no-glow");
            const had = root.classList.contains("bg-live"); root.classList.add("bg-live"); await m.sleep(50); out.bg = getComputedStyle(sw).backgroundColor; if (!had) root.classList.remove("bg-live");
            return out;`);
          if (!(r.glOp > 0.3) || r.glBs === "none") v.push(`glows on: no glow around the unit (opacity ${r.glOp}, ${r.glBs})`);
          if (ng.op !== 0) v.push(`no-glow: the unit still glows (opacity ${ng.op})`);
          const a = /\/\s*([\d.]+)\s*\)/.exec(ng.bg)?.[1] ?? /rgba\([^)]*,\s*([\d.]+)\)/.exec(ng.bg)?.[1] ?? "1";
          if (+a < 0.5) v.push(`bg-live: the strip has no dark fill of its own (${ng.bg})`);
          // one option → no strip, the picture rounded all round, as wide as the content allows
          await page(`await m.closeAll(); await m.openSide("s2"); await m.sleep(800);`);
          const o = await M();
          if (o.sw || o.strip) v.push(`s2 (one option): a strip shows (${J(o.opts)})`);
          if (!o.mdRad.every((x) => x > 4)) v.push(`s2 (one option): the picture's corners ${J(o.mdRad)} (rounded all round)`);
          if (!near(o.st.w, o.want, 1)) v.push(`s2: the unit is ${o.st.w.toFixed(1)} px wide, want ${o.want.toFixed(1)}`);
          if (!near(o.gl.y, o.md.y) || !near(o.gl.h, o.md.h)) v.push(`s2: the glow ${J(o.gl)} doesn't wrap the picture ${J(o.md)}`);
          await shot(`strip-${tag}-one`);
          // motion off: the highlight jumps
          await setMotion(false); await mv(5, 5);
          await page(`await m.closeAll(); await m.openSide("k2"); await m.sleep(500);`);
          const r0 = await M();
          const g0 = await glide(r0.mode === "youtube" ? "image" : "youtube");
          if (!g0) v.push("motion off: no strip highlight");
          else if (between(g0)) v.push(`motion off: the highlight still glides (${between(g0)} frames between)`);
          await sleep(100);
          const r1 = await M();
          if (r1.hl && r1.on && !near(r1.hl.x + r1.hl.w / 2, r1.on.x + r1.on.w / 2, 1)) v.push(`motion off: the highlight ${J(r1.hl)} isn't on the chosen option ${J(r1.on)}`);
        } finally {
          fs.writeFileSync(INDEX, idx0);
          win.webContents.session.webRequest.onBeforeRequest(null);
          await page(`await m.closeAll();`); await setMotion(true);
          win.setContentSize(1400, 900); await sleep(300); await loadUi();
        }
        return v;
      });
    }

    for (const mode of ["on", "off", "reduced"]) {
      await cell(`motion:${mode}`, async () => {
        await setMotion(mode !== "off"); await reducedMotion(mode === "reduced"); await sleep(300);
        const r = await page(`await m.closeAll(); await m.sleep(400); m.ctx(m.thumb("k2"));
          const props = new Set(); let n = 0; const t0 = performance.now();
          await new Promise((res) => { const f = () => { const s = document.querySelector(".side-panel");
            if (s) for (const a of s.getAnimations({ subtree: true })) { if (a.effect?.target?.matches?.("img, video")) continue; n++;
              for (const k of a.effect?.getKeyframes?.() ?? []) for (const p of Object.keys(k)) if (!["offset", "easing", "composite", "computedOffset"].includes(p)) props.add(p); }
            if (performance.now() - t0 < 500) requestAnimationFrame(f); else res(); }; requestAnimationFrame(f); });
          return { props: [...props], n, open: !!m.side() };`);
        const v = [];
        if (!r.open) return ["no sidebar"];
        if (mode === "on") {
          if (!r.n) v.push("the sidebar didn't animate in");
          const bad = r.props.filter((p) => !["transform", "opacity", "translate"].includes(p));
          if (bad.length) v.push(`it animates ${bad.join(", ")} (transform / opacity only)`);
        } else {
          // only opacity, nothing moves: the open fades in, a switch cross-fades, the close fades out (MO.judge)
          const nf = "await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));";
          const o = await page(`await m.closeAll(); await m.sleep(400);
            let s = ${MO.SAMPLE({ panel: ".side-panel" }, 600)}; ${nf} m.ctx(m.thumb("k2")); await m.sleep(50);
            const props = new Set(${MO.OPACITY_ONLY}(m.side() ?? document.body)); const open = await s; await m.sleep(300);
            s = ${MO.SAMPLE({ live: ".side-panel .side-content:not(.opening):not(.side-exit)", exit: ".side-panel .side-content.side-exit" }, 600)}; ${nf}
            m.ctx(m.thumb("k3")); await m.sleep(50); for (const p of ${MO.OPACITY_ONLY}(m.side() ?? document.body)) props.add(p); const sw = await s; await m.sleep(300);
            s = ${MO.SAMPLE({ panel: ".side-panel" }, 600)}; ${nf} m.key("Escape"); const close = await s;
            return { open, sw, close, props: [...props] };`);
          console.log(`        ${mode}: open ${MO.brief(o.open.panel)} | new ${MO.brief(o.sw.live)} | old ${MO.brief(o.sw.exit)} | close ${MO.brief(o.close.panel)}`);
          if (o.props.length) v.push(`${mode}: it animates ${o.props.join(", ")} (opacity only)`);
          v.push(...MO.judge(`${mode}, open: the panel`, o.open.panel, { appear: true }),
            ...MO.judge(`${mode}, switch: the new content`, o.sw.live, { appear: true, size: false }),
            ...MO.judge(`${mode}, switch: the old content`, o.sw.exit, { leave: true, size: false }),
            ...MO.judge(`${mode}, close: the panel`, o.close.panel, { leave: true }));
          if (mode === "off") { await page(`await m.closeAll(); await m.sleep(300); m.ctx(m.thumb("k2")); await m.sleep(60);`); await shot("motion-off-midfade"); }
        }
        return v;
      });
    }
    await reducedMotion(false); await setMotion(true);

    // the focused card: the accent ring + the accent glow (the theme colour like hover, never plain white); Glow effects off
    // → the ring alone
    await cell("look:focus", async () => {
      const v = [];
      await mv(5, 5, 100);
      const r = await page(`await m.closeAll(); await m.openSide("k2"); await m.sleep(500); const c = document.querySelector(".card.lib.focused"); if (!c) return null;
        const cs = getComputedStyle(c); const out = { acc: m.accent(), oc: cs.outlineColor, os: cs.outlineStyle, ow: parseFloat(cs.outlineWidth), off: parseFloat(cs.outlineOffset), bs: cs.boxShadow, lift: new DOMMatrix(cs.transform).m42 };
        document.documentElement.classList.add("no-glow"); await m.sleep(60); const c2 = getComputedStyle(c); out.ng = { oc: c2.outlineColor, bs: c2.boxShadow };
        document.documentElement.classList.remove("no-glow"); return out;`);
      if (!r) return ["no focused card"];
      if (r.oc !== r.acc || r.os === "none" || !(r.ow >= 1.5)) v.push(`the focused card's ring: ${r.os} ${r.ow}px ${r.oc}, expected the accent ${r.acc}`);
      // the ring sits flush (not 3 px off the card), and the card is held lifted like its hover
      if (Math.abs(r.off) > 0.5) v.push(`the focused card's outline floats ${r.off}px off its edge — it sits flush`);
      if (!(r.lift <= -2)) v.push(`the focused card isn't lifted (translateY ${r.lift}) — the lift is what tells it from a selected card`);
      if (!r.bs.includes(r.acc)) v.push(`no accent glow on the focused card (box-shadow ${r.bs})`);
      if (r.ng.oc !== r.acc) v.push(`Glow effects off: the ring is ${r.ng.oc}`);
      if (r.ng.bs.includes(r.acc)) v.push(`Glow effects off: the focused card still glows (${r.ng.bs})`);
      await shot("look-focus");
      return v;
    });

    // "go to playing": the spotlight that shows where the playing wallpaper is
    const LOCATE = (btn) => `await m.closeAll(); await m.sleep(200); const b = document.querySelector('[data-go-playing="${btn}"]'); if (!b || b.disabled) return { btn: false };
      b.click(); const t0 = performance.now(); const fx0 = document.querySelector(".locate-fx");
      const out = { btn: true, atClick: !!fx0 && !!fx0.querySelector(".lfx-dim") && !fx0.querySelector(".lfx-edge"), edge: null, preDim: 0, seen: null, gone: null, dim: 0, rings: 0, scale: 1, glow: false, anims: 0, still: false, outline: null, fo: [], np: [] };
      await new Promise((res) => { const f = () => { const t = performance.now() - t0; const fx = document.querySelector(".locate-fx");
        if (fx) { if (out.seen == null) out.seen = Math.round(t); out.still = fx.classList.contains("still");
          const d = fx.querySelector(".lfx-dim"); if (d) out.dim = Math.max(out.dim, +getComputedStyle(d).opacity);
          if (fx.querySelector(".lfx-edge")) { if (out.edge == null) out.edge = Math.round(t); } else if (d) out.preDim = Math.max(out.preDim, +getComputedStyle(d).opacity);
          const rs = [...fx.querySelectorAll(".lfx-ring")]; out.rings = Math.max(out.rings, rs.length);
          for (const r of rs) { const tf = getComputedStyle(r).transform; if (tf && tf !== "none") { const mm = new DOMMatrix(tf); out.scale = Math.max(out.scale, mm.a, mm.d); } }
          if (fx.querySelector(".lfx-glow")) out.glow = true;
          out.anims = Math.max(out.anims, fx.getAnimations({ subtree: true }).length);
          out.fo.push(+(+getComputedStyle(fx).opacity).toFixed(3)); for (const p of ${MO.OPACITY_ONLY}(fx)) if (!out.np.includes(p)) out.np.push(p);
          const el = document.querySelector(".locate-flash"); if (el) { out.outline = getComputedStyle(el).outlineColor; out.olOff = parseFloat(getComputedStyle(el).outlineOffset);
            const a = d?.getBoundingClientRect(), b = el.getBoundingClientRect();
            if (a) out.holeOff = Math.max(out.holeOff ?? 0, Math.abs(a.left - b.left), Math.abs(a.top - b.top), Math.abs(a.right - b.right), Math.abs(a.bottom - b.bottom)); }
          // the hole never leaves the window — from the click on (a target far off in the bar must not leave part of the app lit)
          if (d) { const a = d.getBoundingClientRect(); out.holeOut = Math.max(out.holeOut ?? 0, -a.left, -a.top, a.right - innerWidth, a.bottom - innerHeight); } }
        else if (out.seen != null && out.gone == null) out.gone = Math.round(t);
        if (t < 2800) requestAnimationFrame(f); else res(); }; requestAnimationFrame(f); });
      out.acc = (() => { const d = document.createElement("div"); d.style.color = "var(--success)"; document.body.appendChild(d); const c = getComputedStyle(d).color; d.remove(); return c; })(); out.left = !!document.querySelector(".locate-fx, .locate-flash"); return out;`;
    // live wallpaper behind the tabs → the panel has no fill, its section cards hold the darkness; the head is see-through
    // too, and the content scrolls below it (never under it)
    // docs/decisions.md § "Show focus rings only while tabbing" — a click + a key: no ring; Tab: the accent ring (never the system's yellow)
    // the CHECKED playlist toggle keeps its tick on hover — a tick cut through the square (the thumbnail showing in it)
    // loses its contrast against the paler hover colour:
    // hovered, the box must still be accent AND carry a dark tick (counted in real pixels, not computed styles)
    await cell("look:plCheck", async () => {
      const v = [];
      await page(`await m.closeAll();`); await tab("Library");
      const r = await page(`const t = m.card("k1")?.querySelector(".pl-toggle.on"); return t ? m.rect(t) : null;`);
      if (!r) return ["no checked playlist box on k1's card (k1 is in the playlist)"];
      const acc = (await page(`return m.accent();`)).match(/\d+/g).map(Number);
      const count = async () => { const img = await win.webContents.capturePage({ x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.w), height: Math.round(r.h) });
        const b = img.toBitmap(); let n = 0, dark = 0; const tot = b.length / 4;
        for (let i = 0; i < b.length; i += 4) { const d = Math.abs(b[i + 2] - acc[0]) + Math.abs(b[i + 1] - acc[1]) + Math.abs(b[i] - acc[2]); if (d < 90) n++;
          if (b[i + 2] + b[i + 1] + b[i] < 180) dark++; }
        return { acc: n / tot, tick: dark / tot }; };
      await mv(r.x + r.w / 2, r.y - 30, 400); // on the card, not the box
      const rest = await count();
      await mv(r.x + r.w / 2, r.y + r.h / 2, 500); // on the box
      const hov = await count();
      console.log(`        the checked box: card hovered ${JSON.stringify(rest)}, box hovered ${JSON.stringify(hov)}`);
      if (rest.acc < 0.3) v.push(`the checked box isn't a filled accent square (${rest.acc.toFixed(2)} of its pixels)`);
      if (hov.acc < 0.3) v.push(`hovered, the checked box loses its fill (${hov.acc.toFixed(2)} accent)`);
      // the tick is thin: ~5 % of the 20 px box is dark when it's solid; a see-through tick over k1's bright bars is ~0
      if (hov.tick < 0.03) v.push(`hovered, the tick vanishes into the fill (${hov.tick.toFixed(3)} dark pixels)`);
      await mv(5, 5, 100);
      return v;
    });

    await cell("look:focusRing", async () => {
      const v = [];
      const r = await page(`await m.closeAll(); return m.rect(document.querySelector('[data-go-playing="library"]'));`);
      await mv(r.x + r.w / 2, r.y + r.h / 2, 150);
      send({ type: "mouseDown", x: Math.round(r.x + r.w / 2), y: Math.round(r.y + r.h / 2), button: "left", clickCount: 1 }); await sleep(40);
      send({ type: "mouseUp", x: Math.round(r.x + r.w / 2), y: Math.round(r.y + r.h / 2), button: "left", clickCount: 1 }); await sleep(2200);
      send({ type: "keyDown", keyCode: "j" }); send({ type: "char", keyCode: "j" }); send({ type: "keyUp", keyCode: "j" }); await sleep(200);
      const a = await page(`const e = document.activeElement; const cs = getComputedStyle(e); return { tag: e.tagName, fv: e.matches(":focus-visible"), os: cs.outlineStyle, ow: parseFloat(cs.outlineWidth) };`);
      console.log(`        click + "j": ${JSON.stringify(a)}`);
      if (a.os !== "none" && a.ow > 0) v.push(`a click then a letter: the clicked ${a.tag} shows a focus ring (${a.os} ${a.ow}px)`);
      send({ type: "keyDown", keyCode: "Tab" }); send({ type: "keyUp", keyCode: "Tab" }); await sleep(200);
      const b = await page(`const e = document.activeElement; const cs = getComputedStyle(e); return { tag: e.tagName, os: cs.outlineStyle, oc: cs.outlineColor, acc: m.accent() };`);
      console.log(`        Tab: ${JSON.stringify(b)}`);
      if (b.tag !== "BODY" && (b.os === "none" || b.oc !== b.acc)) v.push(`Tab: the focused ${b.tag} has no accent ring (${b.os} ${b.oc}, accent ${b.acc})`);
      await mv(5, 5, 50); send({ type: "mouseDown", x: 5, y: 300, button: "left", clickCount: 1 }); send({ type: "mouseUp", x: 5, y: 300, button: "left", clickCount: 1 }); await sleep(200);
      if (await page(`return document.documentElement.classList.contains("kbd-nav");`)) v.push("a pointer press didn't end keyboard mode");
      return v;
    });

    await cell("look:liveBg", async () => {
      const v = [];
      const read = () => page(`await m.closeAll(); await m.openSide("k2"); await m.sleep(500); const p = m.side();
        const alpha = (c) => { const x = c.match(/[0-9.]+/g)?.map(Number) ?? []; return c.includes("/") || c.startsWith("rgba") ? x[x.length - 1] : 1; };
        const title = document.querySelector(".lib-title");
        const sec = p.querySelector(".side-sec");
        return { sec: sec ? alpha(getComputedStyle(sec).backgroundColor) : null, bgImg: getComputedStyle(p).backgroundImage, panel: alpha(getComputedStyle(p).backgroundColor), head: alpha(getComputedStyle(p.querySelector(".side-head")).backgroundColor),
          name: title ? alpha(getComputedStyle(title).backgroundColor) : null, scroller: getComputedStyle(p).overflowY,
          inner: getComputedStyle(p.querySelector(".side-scroll")).overflowY, live: document.documentElement.classList.contains("bg-live"),
          // the title's shadow: drawn by the unclipped wrapper, never a text-shadow inside the clamped (overflow: hidden) h2
          tShadow: getComputedStyle(p.querySelector(".side-head h2")).textShadow, wFilter: getComputedStyle(p.querySelector(".side-head-text")).filter,
          wClip: [p.querySelector(".side-head-text"), p.querySelector(".side-head")].map((e) => getComputedStyle(e).overflow) };`);
      const off = await read(); console.log(`        off: ${JSON.stringify(off)}`);
      if (off.panel < 0.99) v.push(`no live wallpaper behind: the panel is see-through (${off.panel})`);
      await setBgLive(true);
      const on = await read(); console.log(`        on: ${JSON.stringify(on)}`);
      if (!on.live) v.push("the Wallpaper behind every tab row didn't set bg-live");
      else {
        // like the Settings page: the background 100 % see-through, the section cards carry the darkness
        if (on.panel > 0.01 || on.bgImg !== "none") v.push(`live wallpaper: the panel has a fill (alpha ${on.panel}, image ${on.bgImg.slice(0, 60)})`);
        if (on.sec == null || on.sec < 0.4) v.push(`live wallpaper: the section cards don't hold the darkness (alpha ${on.sec}; Settings' .ssection = 0.5)`);
        if (on.head > 0.01) v.push(`live wallpaper: the head has its own background (alpha ${on.head}) — it would read as a band`);
        // the title's shadow is never clipped
        if (on.tShadow !== "none") v.push(`the title's shadow is a text-shadow inside the clamped h2 — its overflow clips it (${on.tShadow})`);
        if (!/drop-shadow/.test(on.wFilter)) v.push(`no Netflix-style drop-shadow on the title's wrapper (filter ${on.wFilter})`);
        if (on.wClip.some((o) => o !== "visible")) v.push(`something around the title clips its shadow (overflow ${on.wClip})`);
        // a tile's hover tints over its dark fill, never replaces it (else it turns transparent; the danger one too: not an
        // opaque block)
        for (const label of ["Open in file manager", "Delete"]) {
          const r = await page(`const t = [...m.side().querySelectorAll(".side-tile")].find((x) => x.textContent.trim() === ${JSON.stringify(label)}); return t ? m.rect(t) : null;`);
          if (!r) { v.push(`no "${label}" tile`); continue; }
          await mv(r.x + r.w / 2, r.y + r.h / 2, 350);
          const h = await page(`const t = [...m.side().querySelectorAll(".side-tile")].find((x) => x.textContent.trim() === ${JSON.stringify(label)});
            const c = getComputedStyle(t).backgroundColor, x = c.match(/[0-9.]+/g).map(Number);
            return { hover: t.matches(":hover"), a: c.includes("/") || c.startsWith("rgba") ? x[x.length - 1] : 1, img: getComputedStyle(t).backgroundImage.slice(0, 40) };`);
          console.log(`        ${label} hovered: ${JSON.stringify(h)}`);
          if (!h.hover) v.push(`"${label}": the real pointer move didn't hover it`);
          else if (h.a < 0.4 || h.a > 0.9) v.push(`"${label}" hovered: its fill alpha is ${h.a} (the tiles' dark 0.5 — not see-through, not solid)`);
          else if (!/gradient/.test(h.img)) v.push(`"${label}" hovered: no tint layered over the fill (${h.img})`);
        }
        await mv(5, 5, 100);
      }
      if (on.scroller !== "hidden" || on.inner !== "auto") v.push(`the content must scroll below the head (panel ${on.scroller}, inner ${on.inner})`);
      await page(`await m.closeAll();`); await setBgLive(false);
      return v;
    });

    // look:sideRhythm — the sidebar's sections sit 12 px apart (.side-body > * + *), the tag row included, and the tags wear the
    // pills' see-through fill and edge (not .tag's solid one). The item's own tag row when it has one; else one is put where
    // LibrarySide renders it (after the hero line): the rules under test are index.css's, not the data's.
    await cell("look:sideRhythm", async () => {
      const r = await page(`await m.closeAll(); await m.openSide("k2"); await m.sleep(500); const b = m.side().querySelector(".side-body");
        // the item's own tag row when it has one (a second row would measure itself, not the sidebar); else one put in its place
        const hero = b.querySelector(".side-hero"), real = b.querySelector(":scope > .side-tags");
        const t = real ?? document.createElement("div");
        if (!real) { t.className = "tags side-tags"; t.innerHTML = '<span class="tag">Anime</span><span class="tag">Retro</span>'; hero.after(t); }
        await m.sleep(400);
        const kids = [...b.children].filter((e) => e.offsetHeight > 0), out = [];
        for (let i = 1; i < kids.length; i++) out.push([kids[i - 1].className.split(" ").pop(), kids[i].className.split(" ").pop(),
          Math.round(kids[i].getBoundingClientRect().top - kids[i - 1].getBoundingClientRect().bottom)]);
        const cs = (e) => e ? { bg: getComputedStyle(e).backgroundColor, edge: getComputedStyle(e).borderTopColor, bw: getComputedStyle(e).borderTopWidth } : null;
        const kidsAt = kids.map((e) => [e.className, Math.round(e.getBoundingClientRect().top), Math.round(e.getBoundingClientRect().bottom), getComputedStyle(e).marginTop, getComputedStyle(e).marginBottom, e === t ? (real ? "REAL" : "INJECTED") : ""]);
        const p = m.side(), mat = (e) => e ? { bg: getComputedStyle(e).backgroundColor, edge: getComputedStyle(e).borderTopColor } : null;
        const res = { gaps: out, kidsAt, tag: cs(t.querySelector(".tag")), pill: cs(b.querySelector(".side-pill")),
          tile: mat(p.querySelector(".side-tile")), strip: mat(p.querySelector(".seg.strip")), mute: mat(p.querySelector(".side-mute:not(.on)")) };
        if (!real) t.remove(); return res;`);
      const v = [];
      console.log(`        ${JSON.stringify(r)}`);
      if (r.gaps.length < 2) v.push(`only ${r.gaps.length + 1} sections showing — proved nothing`);
      for (const [a, b, g] of r.gaps) if (Math.abs(g - 12) > 1) v.push(`${a} → ${b}: ${g} px apart, want the sidebar's 12`);
      if (!r.pill) v.push("no pill to compare the tags with — proved nothing");
      else if (r.tag.bg !== r.pill.bg || r.tag.edge !== r.pill.edge || r.tag.bw !== r.pill.bw) v.push(`the tags' fill / edge ${JSON.stringify(r.tag)} ≠ the pills' ${JSON.stringify(r.pill)}`);
      // the preview's switch strip and its mute button wear the sidebar tiles' material (the preview's controls are one family
      // with the tiles under it)
      if (!r.tile) v.push("no tile to compare the preview's controls with — proved nothing");
      else for (const k of ["strip", "mute"]) if (r[k] && (r[k].bg !== r.tile.bg || r[k].edge !== r.tile.edge))
        v.push(`the preview's ${k} ${JSON.stringify(r[k])} ≠ the tiles' ${JSON.stringify(r.tile)}`);
      if (!r.strip && !r.mute) v.push("neither the preview's strip nor its mute showed — the controls' material proved nothing");
      return v;
    });

    await cell("look:locator", async () => {
      const v = [], J = JSON.stringify;
      await post("/apply", { path: K[0] }); await sleep(1500);
      await mv(5, 5, 100);
      const run = async (label, btn) => { const r = await page(LOCATE(btn)); console.log(`        ${label}: ${J(r)}`); if (!r.btn) v.push(`${label}: no enabled [data-go-playing="${btn}"]`); return r.btn ? r : null; };
      for (const btn of ["library", "bar"]) {
        const r = await run(`${btn}`, btn);
        if (!r) continue;
        if (r.seen == null) { v.push(`${btn}: no spotlight after the button`); continue; }
        // the dim is there from the moment of the click — up in the click's
        // own task (no edge / rings yet: those wait for the glide's arrival) and fades up during the glide
        if (!r.atClick) v.push(`${btn}: no dim (alone) right at the click`);
        if (r.edge == null) v.push(`${btn}: the spotlight never revealed the item (no edge)`);
        else if (r.preDim < 0.8) v.push(`${btn}: the dim didn't come up during the glide (${r.preDim} before arrival at ${r.edge} ms)`);
        if (r.gone == null || r.left) v.push(`${btn}: the spotlight never went away`);
        else if (r.edge != null && (r.gone - r.edge > 2000 || r.gone - r.edge < 1000)) v.push(`${btn}: the spotlight lasted ${r.gone - r.edge} ms after arrival (1–2 s)`);
        if (r.dim < 0.8) v.push(`${btn}: the rest never dimmed (dim opacity ${r.dim})`);
        if (r.rings < 3 || r.scale < 1.05) v.push(`${btn}: no rippling rings (${r.rings} rings, scale ≤ ${r.scale.toFixed(2)})`);
        if (!r.glow) v.push(`${btn}: no glow layer`);
        // the PLAYING colour, not the accent (it finds what's playing; the target already pulses green)
        if (r.outline !== r.acc) v.push(`${btn}: the item's outline ${r.outline}, not the playing colour ${r.acc}`);
        // flush on the item like the focused card — no ring floating off it, the clear hole = the item
        if (Math.abs(r.olOff ?? 99) > 0.5) v.push(`${btn}: the item's outline floats ${r.olOff}px off its edge`);
        if (!(r.holeOff <= 1.5)) v.push(`${btn}: the spotlight's clear hole is off the item by ${r.holeOff}px`);
        if (!(r.holeOut <= 0.5)) v.push(`${btn}: the spotlight's hole went ${r.holeOut}px outside the window — part of the app stays undimmed`);
      }
      // Glow effects off: still the spotlight and the rings, no glow
      await page(`document.documentElement.classList.add("no-glow");`);
      const ng = await run("library, glow off", "library");
      await page(`document.documentElement.classList.remove("no-glow");`);
      if (ng) {
        if (ng.glow) v.push("glow off: the glow layer is there");
        if (ng.dim < 0.8 || ng.rings < 3 || ng.scale < 1.05) v.push(`glow off: no spotlight / rings (${J(ng)})`);
      }
      // animations off: a still highlight for ~1.2 s, nothing animates
      await setMotion(false); await mv(5, 5, 100);
      for (const btn of ["library", "bar"]) {
        const st = await run(`${btn}, animations off`, btn);
        if (!st) continue;
        if (st.seen == null) { v.push(`${btn}, animations off: no highlight`); continue; }
        // nothing moves (opacity only, the ring unscaled); it fades in at the click and out at the end — never pops
        if (!st.still || st.np.length || st.scale > 1.001) v.push(`${btn}, animations off: it moves (still ${st.still}, animates ${J(st.np)}, ring scale ${st.scale})`);
        const fi = st.fo.findIndex((x) => x >= 0.95), fl = st.fo.findLastIndex((x) => x >= 0.95);
        if (!st.fo.slice(0, Math.max(0, fi)).some((x) => x > 0.02 && x < 0.95)) v.push(`${btn}, animations off: it popped in (${J(st.fo.slice(0, 4))})`);
        if (!st.fo.slice(fl + 1).some((x) => x > 0.02 && x < 0.95)) v.push(`${btn}, animations off: it popped out (${J(st.fo.slice(-4))})`);
        if (st.dim < 0.9 || st.rings < 1) v.push(`${btn}, animations off: no dim / ring (${J(st)})`);
        if (!st.atClick) v.push(`${btn}, animations off: no dim right at the click`);
        if (st.gone == null || st.edge == null || st.gone - st.edge > 1600 || st.gone - st.edge < 900) v.push(`${btn}, animations off: shown ${st.gone == null || st.edge == null ? "for ever / never" : st.gone - st.edge + " ms"} (~1.2 s)`);
      }
      await setMotion(true);
      return v;
    });

    // ---- Browse: a local Wallpaper Engine folder: we1 (not in the library) + 900000001 (= s1's Workshop id: in the library)
    const we = path.join(path.dirname(path.dirname(path.dirname(path.dirname(K[0])))), "we-side");
    const ff = (args) => require("child_process").execFileSync("ffmpeg", ["-nostdin", "-loglevel", "error", "-y", ...args], { timeout: 60000 });
    for (const [id, title] of [["9101", "we1"], ["900000001", "s1-local"]]) {
      const d = path.join(we, id); fs.mkdirSync(d, { recursive: true });
      ff(["-f", "lavfi", "-i", "smptebars=size=480x480", "-frames:v", "1", path.join(d, "preview.jpg")]);
      ff(["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(d, "v.mp4")]);
      // Steam's kind of tags (look:sideTags): the category, the type, a genre, a resolution
      fs.writeFileSync(path.join(d, "project.json"), JSON.stringify({ title, type: "video", file: "v.mp4", preview: "preview.jpg",
        ...(title === "we1" ? { tags: ["Wallpaper", "Video", "Anime", "1920 x 1080"] } : {}) }));
    }
    await setSettings({ workshopFolder: we, autoAddWeWallpapersToLibrary: false });
    const srcs = (await http("GET", "/sources")).json;
    const weName = (srcs.find?.((x) => x.index === 3) ?? srcs[3])?.name;
    await loadUi();
    await tab("Browse");
    await page(`m.byText(".pill", ${JSON.stringify(weName)}).click();`);
    for (let i = 0; i < 80; i++) { if (await page(`return !!m.card("we1") && !!m.card("s1-local");`)) break; await sleep(150); }
    const libCount = async () => ((await http("GET", "/library")).json || []).length;

    // look:sideTags — the sidebar lists only the tags that say something (components/sideTags.ts): never "Wallpaper" (every
    // item here is one) nor the type ("Video" / "Scene"), nor a tag repeating a pill it shows (the resolution); a genre stays
    await cell("look:sideTags", async () => {
      const v = [];
      await page(`await m.closeAll();`); await sleep(200);
      const r = await page(`m.thumb("we1").click(); await m.waitSide("browse"); await m.sleep(500); const p = m.side();
        return { tags: [...p.querySelectorAll(".side-tags .tag")].map((e) => e.textContent.trim()),
          pills: [...p.querySelectorAll(".side-hero .side-pill")].map((e) => e.textContent.trim()) };`);
      console.log(`        ${JSON.stringify(r)}`);
      const resPill = r.pills.some((x) => /1920\s*[×x]\s*1080/.test(x));
      for (const t of ["Wallpaper", "Video"]) if (r.tags.includes(t)) v.push(`lists "${t}" (says nothing here)`);
      if (!r.tags.includes("Anime")) v.push(`the genre "Anime" is missing (tags ${JSON.stringify(r.tags)})`);
      if (resPill && r.tags.includes("1920 x 1080")) v.push("lists the resolution its pill already shows");
      if (!resPill && !r.tags.includes("1920 x 1080")) v.push("hid the resolution though no pill shows it");
      await page(`await m.closeAll();`);
      return v;
    });

    await cell("browse:click", async () => {
      const v = [];
      const n0 = await libCount();
      await page(`m.thumb("we1").click();`);
      if (!await page(`return await m.waitSide("browse");`)) return ["no Browse sidebar after a click on we1"];
      await sleep(1500);
      const r = await page(`return { title: m.sideTitle(), dl: !!m.sideBtn("Download & Apply"), media: !!m.side().querySelector("[data-side-media]"), downloading: !!document.querySelector(".dl-overlay") };`);
      if (r.title !== "we1") v.push(`the Browse sidebar shows "${r.title}"`);
      if (!r.dl) v.push("no Download & Apply button");
      if (!r.media) v.push("no picture");
      if (r.downloading || (await libCount()) !== n0) v.push("a click downloaded");
      await shot("browse-click");
      await page(`m.key("Escape"); await m.sleep(400); m.ctx(m.thumb("we1"));`);
      if (!await page(`return await m.waitSide("browse");`)) v.push("no sidebar after a right-click");
      if (await page(`return !!document.querySelector(".modal-backdrop");`)) v.push("the right-click opened a modal");
      return v;
    });

    await cell("browse:inLibrary", async () => {
      const v = [];
      await page(`m.thumb("s1-local").click();`);
      if (!await page(`return await m.waitSide("browse");`)) return ["no sidebar for s1-local"];
      await sleep(300);
      if (!await page(`return !!m.side().querySelector("[data-in-library]");`)) v.push("no In library line for an item the library has");
      if (!await page(`return !!m.sideBtn("Show in Library");`)) return [...v, "no Show in Library"];
      await page(`m.sideBtn("Show in Library").click(); await m.sleep(900);`);
      const r = await page(`return { tab: document.querySelector(".tab.active")?.textContent, title: m.sideTitle(), kind: m.side()?.dataset.side };`);
      if (r.tab !== "Library" || r.kind !== "library" || r.title !== "s1") v.push(`Show in Library → tab ${r.tab}, ${r.kind} sidebar "${r.title}" (expected Library, s1)`);
      await shot("browse-showinlib");
      await tab("Browse");
      return v;
    });

    // the download button's hover effects under a real pointer, and the sidebar's
    await cell("look:dlHover", async () => {
      const v = [], J = JSON.stringify;
      await page(`await m.closeAll();`); await mv(5, 5, 150);
      const c = await page(`const t = m.thumb("we1"); t.scrollIntoView({ block: "center" }); await m.sleep(200); return m.rect(t);`);
      const read = `const b = m.thumb("we1").querySelector(".dl-btn"); const g = b.querySelector(".dl-glyph .dl-arrow"); const cs = getComputedStyle(b), pb = getComputedStyle(b, "::before");
        const an = g.getAnimations(); return { tr: cs.transform, bg: cs.backgroundColor, filter: cs.filter, glow: pb.content !== "none" ? +pb.opacity : 0, anim: an.length, loop: an.some((a) => a.effect.getTiming().iterations === Infinity), op: +getComputedStyle(b).opacity, r: m.rect(b) };`;
      await mv(c.x + c.w * 0.3, c.y + c.h * 0.3, 450);
      const a = await page(read);
      await mv(a.r.x + a.r.w / 2, a.r.y + a.r.h / 2, 500);
      const h = await page(read);
      console.log(`        card hover ${J(a)} → button hover ${J(h)}`);
      if (a.op < 0.9) v.push(`the download button doesn't show on a card hover (opacity ${a.op})`);
      // a bare glyph (no chip); hovered, it lifts + grows and the accent bloom opens behind it
      if (!/rgba\(0, 0, 0, 0\)|transparent/.test(a.bg) || !/rgba\(0, 0, 0, 0\)|transparent/.test(h.bg)) v.push(`the download button has a fill (${a.bg} → ${h.bg}): want a bare glyph`);
      if (h.tr === "none" || h.tr === a.tr) v.push(`hovered, the download button doesn't lift / grow (transform ${a.tr} → ${h.tr})`);
      if (!(h.glow > 0.5) || a.glow > 0.1) v.push(`hovered, no bloom (${a.glow} → ${h.glow})`);
      if (!/drop-shadow/.test(h.filter) || h.filter === a.filter) v.push(`hovered, the arrow doesn't glow (filter ${a.filter} → ${h.filter})`);
      // the arrow drops once and lands (only progress loops — docs/superpowers/specs/2026-11-12-icon-motion-design.md)
      if (!h.anim || h.loop) v.push(`hovered, the arrow doesn't drop once (${h.anim} animations, looping ${h.loop})`);
      if (h.r) await (async () => { const img = await win.webContents.capturePage({ x: Math.max(0, Math.round(c.x - 20)), y: Math.max(0, Math.round(c.y - 20)), width: Math.round(c.w + 40), height: Math.round(c.h + 40) }); fs.writeFileSync(path.join(OUT, "side-look-dlhover.png"), img.toPNG()); })();
      // the Browse sidebar's Download & Apply
      await mv(5, 5, 150);
      await page(`m.thumb("we1").click(); await m.waitSide("browse"); await m.sleep(800);`);
      const readS = `const b = m.sideBtn("Download & Apply"); if (!b) return null; const i = b.querySelector("svg.lucide-download");
        const an = i ? i.getAnimations({ subtree: true }) : [];
        return { tr: getComputedStyle(b).transform, bs: getComputedStyle(b).boxShadow, anim: an.length, loop: an.some((a) => a.effect.getTiming().iterations === Infinity), r: m.rect(b) };`;
      const s0 = await page(readS);
      if (!s0) v.push("no Download & Apply in the Browse sidebar");
      else {
        await mv(s0.r.x + s0.r.w / 2, s0.r.y + s0.r.h / 2, 500);
        const s1 = await page(readS);
        if (s1.tr === s0.tr) v.push(`the sidebar's Download & Apply doesn't lift on hover (${s0.tr})`);
        if (s1.bs === s0.bs) v.push("the sidebar's Download & Apply doesn't glow more on hover");
        if (!s1.anim || s1.loop) v.push(`the sidebar's download arrow doesn't drop once (${s1.anim} animations, looping ${s1.loop})`);
        await shot("look-browse-dlhover");
      }
      await mv(5, 5, 100); await page(`await m.closeAll();`);
      return v;
    });

    await cell("browse:dblclick", async () => {
      await page(`await m.closeAll(); m.thumb("we1").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));`);
      let got = false;
      for (let i = 0; i < 100 && !got; i++) { got = ((await http("GET", "/library")).json || []).some((x) => x.title === "we1"); if (!got) await sleep(150); }
      return got ? [] : ["a double-click didn't download we1"];
    });
    // LIASCAPE_SIDE_SHOTS="1920x1080,1100x700": the look at each size (the Xvfb screen must fit it: LIASCAPE_MATRIX_SCREEN) —
    // the Library sidebar (pointer on its picture), the playing item's, a focused card close-up, the "go to playing" locator
    // mid-effect (grid + bar), the Browse sidebar and a Browse card's download button hovered. Pictures only, no checks.
    for (const size of (E.LIASCAPE_SIDE_SHOTS || "").split(",").filter(Boolean)) {
      await cell(`shots:${size}`, async () => {
        const [W, H] = size.split("x").map(Number);
        const mv = (x, y) => win.webContents.sendInputEvent({ type: "mouseMove", x: Math.round(x), y: Math.round(y) });
        const crop = async (name, r, pad = 24) => { const x = Math.max(0, Math.floor(r.x - pad)), y = Math.max(0, Math.floor(r.y - pad));
          const img = await win.webContents.capturePage({ x, y, width: Math.min(W - x, Math.ceil(r.w + 2 * pad)), height: Math.min(H - y, Math.ceil(r.h + 2 * pad)) });
          fs.writeFileSync(path.join(OUT, `side-${name}.png`), img.toPNG()); };
        win.setContentSize(W, H); await sleep(300);
        await post("/apply", { path: K[0] }); await sleep(1200);
        await loadUi(); await tab("Library"); await sleep(600);
        mv(W - 5, H / 2); await sleep(200);
        await page(`await m.closeAll(); m.thumb("k2").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })); await m.sleep(200);
          const b = m.byText(".lib-ctx button", "Settings"); if (b) b.click(); await m.waitSide("library"); await m.sleep(900);`);
        const media = await page(`const e = m.side()?.querySelector("[data-side-media]"); return e ? m.rect(e) : null;`);
        if (media) { mv(media.x + media.w / 2, media.y + media.h / 2); await sleep(500); }
        await shot(`look-${size}-library`);
        const card = await page(`const c = m.card("k2"); return c ? m.rect(c) : null;`);
        if (card) await crop(`look-${size}-focused`, card, 30);
        await page(`await m.closeAll(); m.thumb("k1").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })); await m.sleep(200);
          const b = m.byText(".lib-ctx button", "Settings"); if (b) b.click(); await m.waitSide("library"); await m.sleep(900);`);
        mv(W / 3, 30); await sleep(300);
        await shot(`look-${size}-library-playing`);
        // live-wallpaper mode: the panel as see-through as the cards' name bars
        await setBgLive(true); await sleep(1200);
        await page(`await m.closeAll(); m.thumb("k2").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })); await m.waitSide("library"); await m.sleep(900);`);
        mv(W / 3, 30); await sleep(300);
        await shot(`look-${size}-library-live`);
        const head = await page(`const h = m.side()?.querySelector(".side-head"); return h ? m.rect(h) : null;`);
        if (head) await crop(`look-${size}-head-live`, head, 6);
        await page(`await m.closeAll();`); await setBgLive(false);
        await page(`await m.closeAll();`);
        // the locator: the grid scrolled so k1 is off (if it can scroll), then the button; captured mid-effect
        await page(`const sc = document.querySelector(".lib-scroll"); sc.scrollTop = sc.scrollHeight; await m.sleep(200);
          document.querySelector('[data-go-playing="library"]')?.click();`);
        await sleep(700); await shot(`look-${size}-locator-grid`);
        await sleep(2200);
        await page(`const r = document.querySelector(".playlist-bar-row"); if (r) r.scrollLeft = r.scrollWidth; await m.sleep(200);
          document.querySelector('[data-go-playing="bar"]')?.click();`);
        await sleep(650); await shot(`look-${size}-locator-bar`);
        await sleep(2200);
        // Browse: the we-side folder (set up above), we1's sidebar, then a card's download button under the pointer
        await tab("Browse");
        await page(`m.byText(".pill", ${JSON.stringify(weName)})?.click();`);
        for (let i = 0; i < 60; i++) { if (await page(`return !!m.card("we1");`)) break; await sleep(150); }
        await page(`await m.closeAll(); m.thumb("we1").click(); await m.waitSide("browse"); await m.sleep(1400);`);
        await shot(`look-${size}-browse`);
        await page(`await m.closeAll(); await m.sleep(300);`);
        const dl = await page(`const t = m.thumb("we1"); if (!t) return null; t.scrollIntoView({ block: "center" }); await m.sleep(200); return m.rect(t);`);
        if (dl) {
          mv(dl.x + dl.w / 2, dl.y + dl.h / 2); await sleep(300);
          const b = await page(`const e = m.thumb("we1")?.querySelector(".dl-btn"); return e ? m.rect(e) : null;`);
          if (b) { mv(b.x + b.w / 2, b.y + b.h / 2); await sleep(450); }
          await crop(`look-${size}-dl-hover`, dl, 30);
        }
        mv(W - 5, 5); await tab("Library");
        win.setContentSize(1400, 900); await sleep(300);
        return [];
      });
    }
  } catch (e) {
    results.push({ name: "setup", v: [e.message] });
    console.log(`ERROR setup: ${e.message}`);
  }
  const fail = results.filter((r) => r.v.length).length;
  console.log(`SIDEBAR pass=${results.length - fail} fail=${fail}`);
  fs.writeFileSync(path.join(OUT, "sidebar.json"), JSON.stringify(results, null, 1));
  app.exit(fail ? 1 : 0);
});
