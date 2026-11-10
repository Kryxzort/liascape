// Wallpaper Engine-style sidebar probe — `scripts/test-ui-matrix.sh --probe probe-sidebar.js` (the matrix's hermetic
// stack: private backend + headless liascape-player + this tree's UI bundle on a private Xvfb). Owner 2026-11-10: "instead
// of a settings menu when clicking right click and settings, it should open a sidebar when you focus a card and thats what
// has all the 4 options from the right click menu. same for the browse tab" (docs/superpowers/specs/2026-11-10-we-sidebar-design.md).
//   lib:click            a plain click focuses the card AND applies it (WE); the sidebar shows it — volume, speed, the actions
//   lib:rightClick       right-click = the menu (its Settings opens the sidebar, nothing applies); with the sidebar open it moves to the card
//   lib:fourOptions      the sidebar's Open in file manager (stubbed /open), Delete (+ Undo), Delete from source (a Workshop item)
//   lib:volume           its volume slider persists the item's own volume
//   lib:still            a `library-item-changed` (two volume keybinds on the playing item) moves nothing and replays nothing;
//                        the slider follows (the 2026-11-10 morph-replay bug's guard, kept for the sidebar)
//   lib:keys             ← → ↑ ↓ move the focus between cards, Enter applies, Escape closes
//   lib:selection        a focused card inside a Ctrl-selection: the sidebar says how many it applies to
//   bar:settings         the playlist bar's "Settings" opens the sidebar on that item
//   lib:levels           Basic hides Speed; an item with its own speed shows it anyway
//   lib:popin            a scene's sidebar shows its body once, with its scene properties in it — nothing pops in later
//   browse:click         a Browse click / right-click opens the Browse sidebar and downloads nothing
//   browse:inLibrary     an item the library has: "In your library" + Show in Library → the Library tab, that item focused
//   browse:dblclick      a double-click downloads & applies
//   motion:on|off|reduced the open slides/fades (transform + opacity only); animations off / reduced motion → nothing animates
// Screenshots: <LIASCAPE_OUT>/side-<cell>.png. Exit 1 on any FAIL. LIASCAPE_ONLY = a regex over the cell names.
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

const E = process.env;
const U = E.LIASCAPE_URL;
const K = JSON.parse(E.LIASCAPE_CLIPS);
const SC = JSON.parse(E.LIASCAPE_SCENES || "[]");
const OUT = E.LIASCAPE_OUT;
const ONLY = E.LIASCAPE_ONLY ? new RegExp(E.LIASCAPE_ONLY) : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.setPath("userData", path.join(OUT, "electron-user-data"));

async function http(method, p, body) {
  const r = await fetch(U + p, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null; try { json = await r.json(); } catch { /* empty */ }
  return { status: r.status, json };
}
const post = (p, b = {}) => http("POST", p, b);
const getSettings = async () => (await http("GET", "/settings")).json;
async function setSettings(patch) { await post("/settings", { ...(await getSettings()), ...patch }); }
const current = async () => (await http("GET", "/current")).json?.path ?? null;
const libItem = async (p) => ((await http("GET", "/library")).json || []).find((i) => i.videoPath === p);

let win;
const js = (code) => win.webContents.executeJavaScript(code);
const PAGE = `window.__sb = {
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  byText(sel, text) { return [...document.querySelectorAll(sel)].find((e) => e.textContent.trim() === text); },
  card(t) { return [...document.querySelectorAll(".card.lib")].find((c) => c.querySelector(".lib-title")?.title === t); },
  thumb(t) { return this.card(t)?.querySelector(".thumb-wrap"); },
  bar(t) { return [...document.querySelectorAll(".pl-item")].find((e) => e.title === t); },
  ctx(el) { if (!el) throw new Error("no element to right-click"); const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.x + 10, clientY: r.y + 10 })); },
  key(k) { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); },
  side(kind) { return document.querySelector(kind ? '.side-panel[data-side="' + kind + '"]:not(.closing)' : ".side-panel:not(.closing)"); },
  sideTitle() { return this.side()?.querySelector(".side-head h2")?.textContent.trim() ?? null; },
  sideBtn(text) { return [...(this.side()?.querySelectorAll("button, a") ?? [])].find((b) => b.textContent.trim() === text || b.textContent.trim().startsWith(text + " ")); },
  sideRow(name) { return this.side()?.querySelector('[data-side-row="' + name + '"]'); },
  setValue(el, v) { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(el, String(v)); el.dispatchEvent(new Event("input", { bubbles: true })); },
  rect(el) { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; },
  // the right-click menu's "Settings": the sidebar on that card, without applying it
  async openSide(t) { this.ctx(this.thumb(t)); await this.sleep(150); const b = this.byText(".lib-ctx button", "Settings"); if (!b) throw new Error("no Settings in the menu of " + t); b.click(); await this.waitSide("library"); await this.sleep(150); },
  async closeAll() { for (let i = 0; i < 3; i++) { if (!document.querySelector(".side-panel, .ctx-menu")) return; this.key("Escape"); await this.sleep(300); } },
  async waitSide(kind, ms = 2000) { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (this.side(kind)) return true; await this.sleep(30); } return false; },
}; true`;
const page = (code) => js(`(async () => { const m = window.__sb; ${code} })()`);
async function loadUi() {
  await win.loadURL(U + "/");
  // /open would start a real file manager, the unsubscribe a Steam call: recorded, never sent
  await js(`(() => { window.__opened = []; const f = window.fetch; window.fetch = (u, o) => { const p = String(u).replace(/^https?:\\/\\/[^/]+/, "").split("?")[0];
    if ((o?.method || "GET") === "POST" && (p === "/open" || p.startsWith("/workshop/unsubscribe") || p === "/library/delete-from-source")) { window.__opened.push({ p, body: o?.body ?? null });
      return Promise.resolve(new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } })); }
    return f(u, o); }; })(); true`);
  for (let i = 0; i < 100; i++) { if (await js(`document.querySelectorAll('.card.lib').length`) >= 4) break; await sleep(100); }
  await js(PAGE); await sleep(400);
}
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
const T = (p) => (p ? path.basename(p).replace(/\.[^.]+$/, "") : String(p));

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
        btns: ["Play", "Playing", "Open in file manager", "Delete"].filter((t) => m.sideBtn(t)), modal: !!document.querySelector(".modal-backdrop"),
        focused: [...document.querySelectorAll(".card.lib.focused")].map((c) => c.querySelector(".lib-title")?.title) };`);
      const v = [];
      if (r.title !== "k2") v.push(`the sidebar shows "${r.title}", not k2`);
      if (r.ranges < 2) v.push(`${r.ranges} sliders in the sidebar (volume + speed)`);
      for (const b of ["Open in file manager", "Delete"]) if (!r.btns.includes(b)) v.push(`no "${b}" button`);
      if (!r.btns.includes("Play") && !r.btns.includes("Playing")) v.push(`no Play button`);
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
      await page(`await m.closeAll(); m.ctx(m.thumb("k3")); await m.sleep(300);`);
      let r = await page(`return { side: !!m.side(), menu: [...document.querySelectorAll(".ctx-menu button")].map((b) => b.textContent.trim()) };`);
      // closed: the menu alone (a docked sidebar opening would re-fit the grid under the menu and the pointer)
      if (r.side) v.push("a right-click opened the sidebar by itself");
      for (const t of ["Settings", "Open in file manager", "Delete"]) if (!r.menu.includes(t)) v.push(`the menu has no "${t}" ([${r.menu}])`);
      await page(`m.byText(".lib-ctx button", "Settings").click();`);
      if (!await page(`return await m.waitSide("library");`)) return [...v, "the menu's Settings didn't open the sidebar"];
      if (await page(`return m.sideTitle();`) !== "k3") v.push(`Settings → the sidebar shows "${await page(`return m.sideTitle();`)}"`);
      await shot("lib-rightclick");
      // open: a right-click on another card moves the sidebar to it (and shows the menu)
      await page(`m.ctx(m.thumb("k4")); await m.sleep(300);`);
      r = await page(`return { title: m.sideTitle(), menu: !!document.querySelector(".ctx-menu") };`);
      if (r.title !== "k4") v.push(`with the sidebar open, a right-click on k4 left it on "${r.title}"`);
      if (!r.menu) v.push("no menu on that right-click");
      await page(`m.key("Escape"); await m.sleep(300);`);
      const after = await page(`return { menu: !!document.querySelector(".ctx-menu"), side: !!m.side() };`);
      if (after.menu) v.push("Escape didn't close the menu");
      if (!after.side) v.push("the first Escape closed the sidebar along with the menu");
      await sleep(600);
      if ((await current()) !== before) v.push(`a right-click applied (${T(before)} → ${T(await current())})`);
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
        fetch("/volume", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ delta: -5 }) });
        setTimeout(() => fetch("/volume", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ delta: -5 }) }), 900);
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
      const order = await page(`return [...document.querySelectorAll(".card.lib .lib-title")].map((e) => e.title);`);
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
      await page(`m.ctx(m.bar("k2")); await m.sleep(300); const b = [...document.querySelectorAll(".pl-ctx button")].find((x) => /^Settings/.test(x.textContent.trim())); if (!b) throw new Error("no Settings in the playlist bar's menu"); b.click();`);
      const open = await page(`return await m.waitSide("library");`);
      const t = await page(`return m.sideTitle();`);
      return open && t === "k2" ? [] : [`the bar's Settings → sidebar ${open ? `"${t}"` : "closed"}`];
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
      const r = await page(`m.ctx(m.thumb("s1")); await m.sleep(120); m.byText(".lib-ctx button", "Settings").click(); const out = []; const t0 = performance.now();
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

    for (const mode of ["on", "off", "reduced"]) {
      await cell(`motion:${mode}`, async () => {
        await setMotion(mode !== "off"); await reducedMotion(mode === "reduced"); await sleep(300);
        const r = await page(`await m.closeAll(); await m.sleep(400); m.ctx(m.thumb("k2")); await m.sleep(120); m.byText(".lib-ctx button", "Settings").click();
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
        } else if (r.n) v.push(`${mode}: it still animates (${r.props.join(", ")})`);
        return v;
      });
    }
    await reducedMotion(false); await setMotion(true);

    // ---- Browse: a local Wallpaper Engine folder: we1 (not in the library) + 900000001 (= s1's Workshop id: in the library)
    const we = path.join(path.dirname(path.dirname(path.dirname(path.dirname(K[0])))), "we-side");
    const ff = (args) => require("child_process").execFileSync("ffmpeg", ["-nostdin", "-loglevel", "error", "-y", ...args], { timeout: 60000 });
    for (const [id, title] of [["9101", "we1"], ["900000001", "s1-local"]]) {
      const d = path.join(we, id); fs.mkdirSync(d, { recursive: true });
      ff(["-f", "lavfi", "-i", "smptebars=size=480x480", "-frames:v", "1", path.join(d, "preview.jpg")]);
      ff(["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(d, "v.mp4")]);
      fs.writeFileSync(path.join(d, "project.json"), JSON.stringify({ title, type: "video", file: "v.mp4", preview: "preview.jpg" }));
    }
    await setSettings({ workshopFolder: we, autoAddWeWallpapersToLibrary: false });
    const srcs = (await http("GET", "/sources")).json;
    const weName = (srcs.find?.((x) => x.index === 3) ?? srcs[3])?.name;
    await loadUi();
    await tab("Browse");
    await page(`m.byText(".pill", ${JSON.stringify(weName)}).click();`);
    for (let i = 0; i < 80; i++) { if (await page(`return !!m.card("we1") && !!m.card("s1-local");`)) break; await sleep(150); }
    const libCount = async () => ((await http("GET", "/library")).json || []).length;

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

    await cell("browse:dblclick", async () => {
      await page(`await m.closeAll(); m.thumb("we1").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));`);
      let got = false;
      for (let i = 0; i < 100 && !got; i++) { got = ((await http("GET", "/library")).json || []).some((x) => x.title === "we1"); if (!got) await sleep(150); }
      return got ? [] : ["a double-click didn't download we1"];
    });
  } catch (e) {
    results.push({ name: "setup", v: [e.message] });
    console.log(`ERROR setup: ${e.message}`);
  }
  const fail = results.filter((r) => r.v.length).length;
  console.log(`SIDEBAR pass=${results.length - fail} fail=${fail}`);
  fs.writeFileSync(path.join(OUT, "sidebar.json"), JSON.stringify(results, null, 1));
  app.exit(fail ? 1 : 0);
});
