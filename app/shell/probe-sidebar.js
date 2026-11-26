// Wallpaper Engine-style sidebar probe — `scripts/test-ui-matrix.sh --probe probe-sidebar.js` (the matrix's hermetic
// stack: private backend + headless liascape-player + this tree's UI bundle on a private Xvfb). docs/decisions.md §
// "Replace the card settings and preview modals with an item sidebar" (.claude/rules/ui/design.md § Item sidebar).
//   lib:click            a plain click applies the card and nothing else: no sidebar, no focus (docs/decisions.md § "Left click
//                        does the tab's main action, right click opens the item sidebar")
//   lib:rightClick       right-click = the sidebar on that card — volume, speed, the actions — nothing applies, no menu; with the
//                        sidebar open it moves to the card; Escape closes it
//   lib:reflow           a right-click on a card in a scrolled grid while the sidebar is closed: the docked sidebar re-fits the
//                        grid's columns, the card stays in view near where it was (real input events)
//   lib:fourOptions      the sidebar's Open in file manager (stubbed /open), Delete (+ Undo), Delete and unsubscribe (a Workshop item)
//   lib:play             the picture is the Play control (no icon): a click applies the item, then the green frame — no
//                        "Playing now" pill — and a Looping chip only while toggle-loop-current is on; no playlist toggle in the head; the head's playlist toggle adds / removes it (the Play / In playlist row is gone)
//   lib:preview          the picture's preview switch: only the options the item has (k1 GIF + Video, k2 none, s2 none, s1 with
//                        a trailer Picture + YouTube), a pick shows its layer and is kept for the next item; the first preview
//                        ever opens muted; the trailer (stubbed) remembers the shared mute + level
//   preview:ytLink       the trailer's links (a stand-in embed, the shell's outside-links.js with a recording openExternal):
//                        a real click on its logo (new window), its title (the frame navigating itself) and a top-page link
//                        each → exactly one openExternal of the watch page; the embed and the app stay where they are
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
//   preview:open         the picture's "open in your default app" button (AppWindow): on k1's Video / GIF / Picture a real click
//                        posts /open/media with that layer's file (stubbed) and applies nothing; a scene's Picture its preview
//   look:previewOpen     Fit: the mute chip's twin (size, inset from its corner, fill, edge, colour); glow on hover, none under
//                        no-glow, the chip's fill under bg-live; fades out on the trailer and back in, motion off too. Shots side-pvopen-*.png
//   look:iconCentre      the open button's and the mute chip's glyphs centred in pixels (pixel-centre.js, ≤ 0.5 css px), at rest and
//                        hovered, at two window sizes. Close-ups side-pxc-*.png
//   lib:clearCrash:on|off  s2 marked crashed: a notice block (the section cards' material, a danger stripe, a .mini Clear) in the
//                        body's 12 px rhythm; Clear → the notice and the whitelist row fade out, what follows glides into their room
//                        (off: fade only, at once), the index mark and the card's go, s2 plays. Screenshots side-crash-*.png
//   lib:clearCrash:multi  s1 and s2 marked crashed, Ctrl-selected with k1: s2's notice reads "2 selected scenes crashed the
//                        player"; Clear in s2's sidebar lifts both marks (index and cards), the selection stays. Screenshots
//                        side-crash-multi.png, side-crash-cleared-multi.png
//   lib:clearCrash:others  s1 alone marked, Ctrl-selected with k1, the sidebar on k1 (no mark of its own): the notice shows
//                        ("1 selected scene crashed the player"), no whitelist row (that is s1's own); Clear lifts s1's mark,
//                        the notice fades out (motion on and off: in-between opacity frames). Screenshot side-crash-others.png
//   lib:fontStandIn:on|off  s2 plays with a font stand-in (its synthetic Ready reports Consolas shown with Cascadia Mono): the
//                        player's scene.fonts → the index → its open sidebar gets one muted line "Uses Consolas, shown with
//                        Cascadia Mono" in Playback, fading in (off: opacity only); a play with every font installed clears it
//                        and the line fades out. Screenshots side-fonts-*.png
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
//   lib:selection        a card right-clicked inside a Ctrl-selection: the sidebar says how many it applies to
//   bar:settings         a right-click on a playlist bar item opens the sidebar on it; nothing applies, no menu
//   lib:levels           Basic hides Speed; an item with its own speed shows it anyway
//   lib:popin            a scene's sidebar shows its body once, with its scene properties in it — nothing pops in later
//   lib:propsFold:on|off|reduced  "Scene properties · 3" is a button that folds s1's section and opens it (real clicks, per
//                        frame): on, the box morphs, the head stays put unstretched, the chevron turns, the rows fade, a block
//                        below glides; off / reduced, opacity only, sizes change at once; glow / no-glow, bg-live. Shots side-fold-*.png
//   lib:propsFoldKeys    Enter on the focused header folds, Space opens; nothing applies, the sidebar stays
//   lib:propsFoldKeep    one remembered fold for every scene: folded on s1 → s2 opens folded, a reload keeps it, opened on s2 → s1 open
//   lib:propsCount       the header counts the shown properties, following s1's condition live (clock off → · 2); s2's group
//                        heading, label and condition-hidden slider don't count; read late, the header never moves once shown
//   side:titleFold:on|off|reduced  a long title (k3 renamed) is a folded button, two lines tall; real clicks unfold it and fold it
//                        back (per frame): on, the box morphs, the words ride unstretched, the scroller and the head's line glide;
//                        off / reduced, sizes change at once and the old title cross-fades into the new. Shots side-title-*.png
//   side:titlePlain      a title that fits in two lines is plain text: no button, no Tab stop, a click changes nothing
//   side:titleFoldKeys   Enter unfolds the focused title, Space folds it; nothing applies; a switch away and back starts it folded
//   side:titleSelect     the title is selectable text (no Copy button, at rest or hovered): a drag selects words without
//                        unfolding, Ctrl+C copies them, a plain click still unfolds. Shot side-titleselect.png
//   lib:preset:props     a preset's sidebar: its base's properties with the preset's values as defaults; a tweak marks it, saved
//                        to the preset alone; Default returns to the preset's value
//   lib:preset:uses      "Uses <base>" (WsListRow) from the preset's own file, no Steam ask; a click focuses the base's card
//   lib:presets:scene    a Library scene with a Workshop id: "Presets" lists its presets on the Browse tab (the CM fixture's
//                        two, marked In library); none on a preset; the Library's Preset filter keeps exactly the presets
//   lib:preset:badge     a preset's card and its sidebar's chip say PRESET, its base's and a plain scene's SCENE: the same
//                        badge in the same corner, the preset's told apart by at least two of fill / letters / ring / glyph,
//                        two themes × glow on / off, its chip's own fill under bg-live. Shots side-preset-badge*.png
//   lib:preset:needsBase[Off]  the base goes with the preset's sidebar open: the cards grey out (status icon fading in, the
//                        reason as its tooltip), the notice (the crash notice's block, --warn) rises in (Off: fades); a click
//                        plays nothing, the status bar says why; "Download it again" = /download of the base, a one-off only
//                        for the library's own copy with a one-off route, disabled with the reason when the mode can't; the
//                        base back → the notice leaves, the cards come back; no-glow, bg-live. Shots side-needsbase-*.png
//   lib:incomplete[Off]  a Workshop scene whose download Steam left empty (GET /library downloadIncomplete): its card greys with
//                        "Download incomplete" over the picture (fading in when the page hears of it; Off: opacity only), no
//                        second status icon; a click plays nothing, the status bar says why; the sidebar's notice says it with
//                        "Redownload"; a click → POST /library/redownload
//                        of its path (held), the button says it's downloading and the line under the words Steam's step; done →
//                        the words fade out, the card and the notice come back; no-glow, bg-live. Shots side-incomplete-*.png
//   lib:scenesBlocked    the scene renderer missing (page-only scenes-blocked): every scene and preset greyed with the reason
//                        (the preset's status icon), no video; a click plays nothing, the status bar and notice say why;
//                        cleared → back
//   lib:baseDelete[Off]  Delete of a base two presets play (card button, Delete key, sidebar; Delete and unsubscribe too) asks,
//                        naming 2; Keep it / Escape delete nothing; Delete trashes it and both presets grey out; a scene no
//                        preset plays and a preset itself delete unasked; the dialog zooms in (Off: fades), no-glow, bg-live.
//                        Shots side-basedel-*.png
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
//   lib:locateSelect     "go to playing" also selects the playing card and opens its sidebar, as a click would, without applying
//                        it: the Library's crosshair with k2 + k3 Ctrl-selected and the sidebar on k3 → the sidebar on k1, the
//                        selection replaced (none left), no /apply; the bar's with the sidebar on k2 → k1; a search hiding k1 →
//                        the Library's says so and changes nothing, the bar's still opens k1 (as its right-click); motion off
//                        → the sidebar on k1 at once
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
if (E.LIASCAPE_SIDE_DPR) app.commandLine.appendSwitch("force-device-scale-factor", E.LIASCAPE_SIDE_DPR); // look:iconCentre at a set ratio

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
  // /open would start a real file manager (/open/media a real player), the unsubscribe a Steam call: recorded, never sent
  // The preset cells' hooks, inert unless a cell sets them: every request recorded (__reqs: [method, path]); /download held
  // and recorded while __dlHold (__dl: its bodies; __dlGo() answers it); /workshop/one-off answered by __oneOff; a
  // /library/trash stubbed while __stubTrash (__trashed: its bodies); GET /library's items patched by __libPatch {path: fields};
  // /library/redownload held and recorded while __redlHold (__redl: its bodies; __redlGo(answer) answers it)
  await js(`(() => { window.__opened = []; window.__reqs = []; window.__dl = []; window.__redl = []; window.__trashed = []; const f = window.fetch;
    const json = (b) => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } }));
    window.fetch = (u, o) => { const p = String(u).replace(/^https?:\\/\\/[^/]+/, "").split("?")[0], m = (o?.method || "GET").toUpperCase();
    window.__reqs.push([m, p]);
    if (m === "POST" && (p === "/open" || p === "/open/media" || p.startsWith("/workshop/unsubscribe") || p === "/library/delete-from-source")) { window.__opened.push({ p, body: o?.body ?? null });
      return json({}); }
    if (m === "POST" && p === "/download" && window.__dlHold) { window.__dl.push(JSON.parse(o.body)); return new Promise((r) => { window.__dlGo = () => r(new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } })); }); }
    if (p === "/workshop/one-off" && window.__oneOff) return json(window.__oneOff);
    if (m === "POST" && p === "/library/redownload" && window.__redlHold) { window.__redl.push(JSON.parse(o.body)); return new Promise((r) => { window.__redlGo = (b) => r(new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } })); }); }
    if (m === "POST" && p === "/library/trash" && window.__stubTrash) { window.__trashed.push(JSON.parse(o.body)); return json({ batch: "" }); }
    if (m === "GET" && p === "/library" && window.__libPatch) return f(u, o).then((r) => r.json()).then((l) => json(l.map((i) => ({ ...i, ...(window.__libPatch[i.videoPath] || {}) }))));
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
// "Wallpaper behind every tab" (the live wallpaper behind the UI → :root.bg-live, the translucent chrome): set
// through /settings and reload the page (a POST doesn't reach the open store)
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
  // window.__fakeWs(type, payload): an event into the page's own socket, before its scripts run (the preset cells: a
  // settings-changed that only the page sees, a library-synced that makes it read the library). The debugger needs a
  // renderer first (one that never loaded anything has none).
  await win.loadURL("about:blank");
  if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach("1.3");
  await win.webContents.debugger.sendCommand("Page.enable");
  await win.webContents.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: `(() => { const O = window.WebSocket, socks = [];
    window.WebSocket = class extends O { constructor(...a) { super(...a); socks.push(this); } };
    window.__fakeWs = (type, payload) => { let n = 0; for (const s of socks) if (s.readyState === 1 && s.onmessage) { s.onmessage({ data: JSON.stringify({ type, payload }) }); n++; } return n; }; })();` });
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
      const v = [];
      let cur = null; for (let i = 0; i < 50 && (cur = await current()) !== K[1]; i++) await sleep(100);
      if (cur !== K[1]) v.push(`the click didn't apply k2 (/current ${T(cur)})`);
      const r = await page(`await m.sleep(300); return { side: !!document.querySelector(".side-panel"), modal: !!document.querySelector(".modal-backdrop"), menu: !!m.menu(),
        focused: [...document.querySelectorAll(".card.lib.focused")].map((c) => c.querySelector(".lib-title")?.dataset.title) };`);
      if (r.side) v.push("a plain click opened the sidebar (it only applies; a right-click opens it)");
      if (r.modal || r.menu) v.push("a modal or menu opened too");
      if (r.focused.length) v.push(`focused cards: [${r.focused}]`);
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
      const c = await page(`await m.sleep(400); return { ranges: m.side().querySelectorAll("input[type=range]").length,
        btns: ["Open in file manager", "Delete"].filter((t) => m.sideBtn(t)), play: !!m.side().querySelector("[data-side-play], [data-side-playing]"),
        modal: !!document.querySelector(".modal-backdrop"),
        focused: [...document.querySelectorAll(".card.lib.focused")].map((c) => c.querySelector(".lib-title")?.dataset.title) };`);
      if (c.ranges < 2) v.push(`${c.ranges} sliders in the sidebar (volume + speed)`);
      for (const b of ["Open in file manager", "Delete"]) if (!c.btns.includes(b)) v.push(`no "${b}" button`);
      if (!c.play) v.push(`no Play control / Playing now badge on the picture`);
      if (c.modal) v.push("a modal opened too");
      if (c.focused.join() !== "k3") v.push(`focused cards: [${c.focused}]`);
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
      // a Workshop item (s1, auto-import off): Delete and unsubscribe is there
      await page(`await m.openSide("s1"); await m.sleep(400);`);
      if (!await page(`return !!m.sideBtn("Delete and unsubscribe");`)) v.push("no Delete and unsubscribe on the Workshop item s1");
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
      await page(`for (const t of ["k1", "k3"]) { m.thumb(t).dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true })); await m.sleep(250); }
        m.ctx(m.thumb("k3")); await m.waitSide("library"); await m.sleep(300);`);
      const r = await page(`return { title: m.sideTitle(), text: m.side()?.querySelector(".side-head")?.textContent ?? "" };`);
      const v = [];
      if (r.title !== "k3") v.push(`the sidebar shows "${r.title}" after Ctrl-clicking k1, k3 and right-clicking k3`);
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
      // "looping this one" is a hero chip, shown only while toggle-loop-current is on
      for (let i = 0; i < 30; i++) { r2 = await page(`const s = m.side(); const f = s.querySelector(".side-stage");
          return { play: !!s.querySelector("[data-side-play]"), frame: !!f?.matches(".is-playing[data-side-playing]"),
            pill: !!s.querySelector("[data-side-media] .side-badge, [data-side-media] [data-side-playing]") || /Playing now/.test(s.querySelector("[data-side-media]")?.textContent ?? ""),
            looping: !!s.querySelector("[data-side-looping]") };`); if (r2.frame) break; await sleep(100); }
      if (!r2.frame) v.push(`playing: the picture's frame isn't marked playing (${JSON.stringify(r2)})`);
      if (r2.pill) v.push(`playing: a "Playing now" pill is back on the picture (${JSON.stringify(r2)})`);
      if (r2.looping) v.push("playing (not looping): a Looping chip shows");
      // toggle-loop-current on → the chip shows; off again → gone. Only a rotating playlist can toggle-loop-current (a lone wallpaper
      // already stays: the backend answers "no playlist is rotating" and keeps nothing) → k3 first in a playlist
      await post("/playlist/play", { paths: [K[2], K[0]] });
      for (let i = 0; i < 50 && (await current()) !== K[2]; i++) await sleep(100);
      await sleep(800);
      await post("/action", { name: "toggle-loop-current" });
      let lp = null; for (let i = 0; i < 30 && !(lp = await page(`return !!m.side().querySelector("[data-side-looping]");`)); i++) await sleep(100);
      await post("/action", { name: "toggle-loop-current" });
      if (!lp) v.push("toggle-loop-current on: no Looping chip in the sidebar's hero");
      let gone = false; for (let i = 0; i < 30 && !(gone = await page(`return !m.side().querySelector("[data-side-looping]");`)); i++) await sleep(100);
      if (!gone) v.push("toggle-loop-current off again: the Looping chip stays");
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

    // The trailer's own links go to the user's browser: the shell's rules (outside-links.js, as main.js installs them) with
    // a recording openExternal, and a stand-in for YouTube's embed (no network): its logo / "Watch on YouTube" (a new
    // window), its title (no target: the frame navigating itself) and a link to the top page. Each real click → exactly one
    // openExternal of the watch page; the embed stays on its embed page and the app on the app.
    await cell("preview:ytLink", async () => {
      const v = [];
      const { guardWebContents } = require("./outside-links");
      const opened = [];
      guardWebContents(win.webContents, { isAppUrl: (u) => { try { return new URL(u).origin === new URL(U).origin; } catch { return false; } },
        openExternal: async (u) => { opened.push(u); } });
      const WATCH = "https://www.youtube.com/watch?v=aqz-KE-bpKQ";
      const standIn = `<!doctype html><body style="margin:0;background:#000">
        <a id="title" href="${WATCH}" style="position:absolute;left:8px;top:8px;width:120px;height:24px;background:#444">title</a>
        <a id="top" href="${WATCH}&top=1" target="_top" style="position:absolute;left:8px;top:48px;width:120px;height:24px;background:#446">top</a>
        <a id="logo" href="${WATCH}" target="_blank" rel="noopener" style="position:absolute;right:8px;bottom:8px;width:90px;height:24px;background:#c00">YouTube</a></body>`;
      const ses = win.webContents.session;
      ses.protocol.handle("https", (req) => new URL(req.url).hostname === "www.youtube.com"
        ? new Response(new URL(req.url).pathname.startsWith("/embed/") ? standIn : "<!doctype html><title>watch page</title>left the embed",
          { headers: { "content-type": "text/html" } })
        : new Response("", { status: 404 }));
      const idx = path.join(path.dirname(SC[0]), "index.json"), idx0 = fs.readFileSync(idx, "utf8");
      const j = JSON.parse(idx0); j["900000001"].youtubeUrl = WATCH; fs.writeFileSync(idx, JSON.stringify(j));
      try {
        await loadUi();
        const open = async () => {
          await page(`await m.closeAll(); await m.openSide("s1"); await m.sleep(400);
            m.side().querySelector('[data-preview-src="youtube"]')?.click(); await m.sleep(300);`);
          for (let i = 0; i < 50; i++) {
            const f = win.webContents.mainFrame.frames.find((x) => /^https:\/\/www\.youtube\.com\/embed\//.test(x.url));
            if (f && await f.executeJavaScript(`!!document.getElementById("logo")`).catch(() => false)) return f;
            await sleep(100);
          }
          return null;
        };
        for (const id of ["logo", "title", "top"]) {
          const f = await open();
          if (!f) { v.push(`${id}: the stand-in embed never loaded`); continue; }
          const fr = await page(`const r = m.side().querySelector(".yt-frame").getBoundingClientRect(); return { x: r.x, y: r.y };`);
          const a = await f.executeJavaScript(`(() => { const r = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
          const x = Math.round(fr.x + a.x), y = Math.round(fr.y + a.y);
          const n0 = opened.length;
          // through the debugger's input: it is routed to the frame under the pointer like a real click (sendInputEvent
          // reaches only the top page's own renderer, never a cross-site frame's)
          const d = win.webContents.debugger; if (!d.isAttached()) d.attach("1.3");
          const mouse = (type) => d.sendCommand("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? "none" : "left", clickCount: type === "mouseMoved" ? 0 : 1 });
          await mouse("mouseMoved"); await sleep(100); await mouse("mousePressed"); await sleep(40); await mouse("mouseReleased");
          await sleep(800);
          const got = opened.slice(n0);
          const frames = win.webContents.mainFrame.frames.map((x) => x.url);
          console.log(`        ${id}: openExternal ${JSON.stringify(got)}, frames ${JSON.stringify(frames)}`);
          if (got.length !== 1 || !got[0].startsWith(WATCH)) v.push(`${id}: openExternal got ${JSON.stringify(got)}, expected one call with ${WATCH}`);
          if (!frames.some((u) => /^https:\/\/www\.youtube\.com\/embed\//.test(u))) v.push(`${id}: the embed left its embed page (${JSON.stringify(frames)})`);
          if (frames.some((u) => /\/watch\?/.test(u))) v.push(`${id}: the watch page opened inside the app (${JSON.stringify(frames)})`);
          if (new URL(win.webContents.getURL()).origin !== new URL(U).origin) v.push(`${id}: the app navigated away (${win.webContents.getURL()})`);
          if (BrowserWindow.getAllWindows().length !== 1) v.push(`${id}: a new window opened`);
        }
      } finally {
        fs.writeFileSync(idx, idx0);
        ses.protocol.unhandle("https");
        await loadUi();
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

    // preview:open — the picture's "open in your default app" button (SidePanel.tsx SideOpen, lucide AppWindow): on k1's
    // Video and GIF (k1) and Picture (k2: no switch, the picture only) a real click at its centre posts /open/media with that
    // layer's file — and applies nothing (it sits above the click-to-play layer); a scene's Picture opens its preview file. /open/media is stubbed in the page
    // (loadUi): nothing really opens.
    const clickAt = async (x, y) => { send({ type: "mouseDown", x: Math.round(x), y: Math.round(y), button: "left", clickCount: 1 }); await sleep(40);
      send({ type: "mouseUp", x: Math.round(x), y: Math.round(y), button: "left", clickCount: 1 }); };
    const pickOpen = (k) => page(`const s = m.side(); const o = s.querySelector('[data-preview-src="${k}"]');
      if (o && o.getAttribute("aria-checked") !== "true") o.click(); await m.sleep(650);
      const b = s.querySelector("[data-side-open]"); if (!b) return null; const c = getComputedStyle(b);
      return { mode: s.querySelector("[data-side-media]")?.dataset.previewMode, on: b.classList.contains("on"), inert: b.inert, file: b.dataset.sideOpen,
        op: +c.opacity, pe: c.pointerEvents, label: b.getAttribute("aria-label"), icon: !!b.querySelector("svg.lucide-app-window"), r: m.rect(b),
        play: !!s.querySelector("[data-side-play]") };`);
    const clickOpen = async (b) => {
      await js(`window.__opened.length = 0; true`);
      await clickAt(b.r.x + b.r.w / 2, b.r.y + b.r.h / 2); await sleep(400);
      return js(`window.__opened.map((o) => ({ p: o.p, body: JSON.parse(o.body || "null") }))`);
    };
    await cell("preview:open", async () => {
      const v = [], J = JSON.stringify;
      const k1 = await libItemByTitle("k1"), k2 = await libItemByTitle("k2"), s2 = await libItemByTitle("s2");
      const gif = k1?.animatedThumbnailPath, pic = k2?.thumbnailPath || k2?.animatedThumbnailPath, scPic = s2?.thumbnailPath || s2?.animatedThumbnailPath;
      if (!gif || !/\.gif$/i.test(gif) || !pic || !scPic) return [`k1 / k2 / s2 lack a local GIF or picture (${J({ gif, pic, scPic })}) — proved nothing`];
      // k1 and k2 not playing: their picture is then the Play control, which a click on the button must not reach
      if ([K[0], K[1]].includes(await current())) { await post("/apply", { path: K[2] }); await sleep(1500); }
      const cur0 = await current();
      for (const [k, want, t] of [["video", K[0], "k1"], ["gif", gif, "k1"], ["image", pic, "k2"]]) {
        await page(`if (m.sideTitle() !== "${t}") { await m.closeAll(); await m.openSide("${t}"); await m.sleep(400); }`);
        const b = await pickOpen(k);
        if (!b) { v.push(`${k}: no open button`); continue; }
        if (b.mode !== k) { v.push(`${k}: the picture shows ${b.mode}`); continue; }
        if (!b.on || b.inert || b.op < 0.95 || b.pe === "none") v.push(`${k}: the button isn't shown / usable (${J(b)})`);
        if (!b.icon) v.push(`${k}: not the AppWindow icon`);
        if (b.label !== "Open in your default app") v.push(`${k}: aria-label ${J(b.label)}`);
        if (!b.play) v.push(`${k}: no click-to-play layer under the button — the "applies nothing" check proved nothing`);
        const sent = await clickOpen(b);
        if (J(sent) !== J([{ p: "/open/media", body: { path: want } }])) v.push(`${k}: a click posted ${J(sent)}, want /open/media {path: ${want}}`);
        await shot(`pvopen-${k}`);
      }
      await sleep(500);
      const cur1 = await current();
      if (cur1 !== cur0) v.push(`a click on the button applied the item (/current ${T(cur1)}, was ${T(cur0)})`);
      await page(`await m.closeAll(); await m.openSide("s2"); await m.sleep(500);`);
      const sb = await pickOpen("image");
      if (!sb || !sb.on) v.push(`s2 (a scene): no open button on its Picture (${J(sb)})`);
      else { const sent = await clickOpen(sb); if (J(sent) !== J([{ p: "/open/media", body: { path: scPic } }])) v.push(`s2: a click posted ${J(sent)}, want its picture ${scPic}`); }
      await mv(5, 5); await page(`await m.closeAll();`);
      return v;
    });

    // look:previewOpen — Fit: the button is the mute chip's twin: its size, its inset from the picture's other bottom corner,
    // its fill, edge, text colour and roundness; it glows on hover like the chip (none under no-glow) and keeps the chip's fill
    // under bg-live; on a layer with no file (the YouTube trailer, stubbed) it fades out, and back in on the Picture (in-between
    // opacity frames, nothing moves), motion off too. Screenshots side-pvopen-*.png.
    await cell("look:previewOpen", async () => {
      const v = [], J = JSON.stringify, near = (a, b, t = 0.75) => Math.abs(a - b) <= t;
      // the chip's resting material, from a stand-in chip where the real one sits (the real one may be lit: unmuted)
      const geo = (cls = "") => page(`const s = m.side(), b = s.querySelector("[data-side-open]"), u = s.querySelector("[data-side-mute]"), md = s.querySelector("[data-side-media]");
        if (!b || !u) return null; const t = document.createElement("button"); t.className = "side-mute"; u.parentElement.appendChild(t);
        const root = document.documentElement, add = "${cls}".split(" ").filter(Boolean); for (const c of add) root.classList.add(c); await m.sleep(60);
        const cs = (e) => { const c = getComputedStyle(e); return { bg: c.backgroundColor, edge: c.borderTopColor, bw: c.borderTopWidth, color: c.color, radius: c.borderTopLeftRadius }; };
        const out = { b: m.rect(b), u: m.rect(u), md: m.rect(md), bs: cs(b), us: cs(t), strip: s.querySelector(".seg.strip") ? m.rect(s.querySelector(".seg.strip")) : null };
        t.remove(); for (const c of add) root.classList.remove(c); return out;`);
      try {
        await loadUi(); await setMotion(true);
        if (!await openVideo("k1")) return ["k1: no Video preview (proved nothing)"];
        await mv(5, 5, 300);
        const g = await geo();
        if (!g) return ["no open button beside the mute chip"];
        console.log(`        ${J(g)}`);
        if (!near(g.b.w, g.u.w, 0.5) || !near(g.b.h, g.u.h, 0.5)) v.push(`size ${g.b.w}×${g.b.h}, the mute chip's ${g.u.w}×${g.u.h}`);
        const bIn = g.md.y + g.md.h - (g.b.y + g.b.h), uIn = g.md.y + g.md.h - (g.u.y + g.u.h);
        const bSide = g.b.x - g.md.x, uSide = g.md.x + g.md.w - (g.u.x + g.u.w);
        if (!near(bIn, uIn) || !near(bSide, uSide)) v.push(`inset from its corner ${bSide.toFixed(1)} / ${bIn.toFixed(1)} px, the chip's ${uSide.toFixed(1)} / ${uIn.toFixed(1)}`);
        if (J(g.bs) !== J(g.us)) v.push(`material ${J(g.bs)}, the chip's ${J(g.us)}`);
        if (g.b.x < g.md.x || g.b.y + g.b.h > g.md.y + g.md.h + 0.5 || (g.strip && g.b.y < g.strip.y + g.strip.h)) v.push(`not inside the picture (${J(g.b)} vs ${J(g.md)})`);
        // hover: the chip's glow + accent edge; no-glow: none; bg-live: still the chip's fill
        await mv(g.b.x + g.b.w / 2, g.b.y + g.b.h / 2, 400);
        const hov = await page(`const b = m.side().querySelector("[data-side-open]"), root = document.documentElement; const c = getComputedStyle(b);
          const out = { glow: c.boxShadow, edge: c.borderTopColor, accent: m.accent() }; root.classList.add("no-glow"); await m.sleep(250);
          out.noGlow = getComputedStyle(b).boxShadow; root.classList.remove("no-glow"); return out;`);
        if (!hov.glow || hov.glow === "none") v.push("glows on: the hovered button doesn't glow");
        if (hov.edge !== hov.accent) v.push(`hovered: edge ${hov.edge}, want the accent ${hov.accent}`);
        if (hov.noGlow !== "none") v.push(`no-glow: the hovered button still glows (${hov.noGlow})`);
        await shot("pvopen-hover");
        await page(`document.documentElement.classList.add("no-glow");`); await sleep(250); await shot("pvopen-noglow"); await page(`document.documentElement.classList.remove("no-glow");`);
        await mv(5, 5, 300);
        const live = await geo("bg-live");
        if (live && J(live.bs) !== J(live.us)) v.push(`bg-live: material ${J(live.bs)}, the chip's ${J(live.us)}`);
      } finally {
        await mv(5, 5); await page(`await m.closeAll();`);
      }
      // a layer with no file to open (the trailer): out on it, back in on the Picture — opacity only
      await withYtStub(async () => {
        for (const on of [true, false]) {
          if (!on) await setMotion(false);
          await page(`await m.closeAll(); await m.openSide("s1"); await m.sleep(400); const o = m.side().querySelector('[data-preview-src="image"]');
            if (o && o.getAttribute("aria-checked") !== "true") o.click(); await m.sleep(600);`);
          const flip = async (to) => { const samp = js(MO.SAMPLE({ open: ".side-panel:not(.closing) [data-side-open]" }, 700));
            await sleep(40); await page(`m.side().querySelector('[data-preview-src="${to}"]')?.click();`); return (await samp).open; };
          const out = await flip("youtube");
          const back = await flip("image");
          if (on) { await flip("youtube"); await page(`m.side().querySelector('[data-preview-src="image"]').click();`); await sleep(80); await shot("pvopen-midfade"); await sleep(600); }
          const mode = on ? "on" : "off";
          console.log(`        motion ${mode}: out ${MO.brief(out)} / in ${MO.brief(back)}`);
          v.push(...MO.judge(`motion ${mode}: leaving`, out, { leave: true, maxMs: 400 }), ...MO.judge(`motion ${mode}: coming back`, back, { appear: true, maxMs: 400 }));
        }
      }).finally(() => setMotion(true));
      // the real live-wallpaper mode, for the eye
      await setBgLive(true);
      try { if (await openVideo("k1")) { await mv(5, 5, 300); await shot("pvopen-live"); } } finally { await page(`await m.closeAll();`); await setBgLive(false); }
      return v;
    });

    // look:iconCentre — the round chips' glyphs are centred in pixels (app/shell/pixel-centre.js: the glyph's drawn box against
    // the chip's drawn box, within 0.5 css px): the open button (on k2's Picture: nothing moves under it) and the mute chip (on
    // k1's Video, paused and hidden while measured), at rest and hovered (the ring without its glow; the volume pill hidden), at two window sizes and
    // four sub-pixel offsets of the picture (its aspect-ratio height lands the chips on any fraction; the offset is a
    // margin on the stage, so every fraction is met, not only the ones a layout happens to give). Within 0.5 css px at a whole
    // device pixel ratio; at a fractional one (the matrix's Xvfb gives 67/64) a device pixel can't be split, so within one.
    // LIASCAPE_SIDE_DPR=1 / 2 runs the probe at that ratio (Chromium's --force-device-scale-factor: an emulated ratio isn't
    // what capturePage reads). Close-ups side-pxc-*.png.
    await cell("look:iconCentre", async () => {
      const v = [];
      const PXC = require("./pixel-centre");
      const sizes = [[1400, 900], [1180, 780]];
      const settle = (sel) => page(`const e = m.side()?.querySelector(${JSON.stringify(sel)}); for (const a of e?.getAnimations({ subtree: true }) ?? []) a.finish(); await m.sleep(60);`);
      let tol = 0.5;
      const one = async (label, chip, glyph, css) => {
        for (const hov of [false, true]) for (const off of [0, 0.25, 0.5, 0.75]) {
          await page(`let st = document.getElementById("__pxoff"); if (!st) { st = document.createElement("style"); st.id = "__pxoff"; document.head.append(st); }
            st.textContent = ".side-panel .side-stage { margin-top: ${6 + off}px !important; transition: none !important; }"; await m.sleep(80);`);
          const r0 = await page(`const e = m.side()?.querySelector(${JSON.stringify(chip)}); return e ? m.rect(e) : null;`);
          if (!r0) { v.push(`${label}: no chip`); return; }
          if (hov) await mv(r0.x + r0.w / 2, r0.y + r0.h / 2, 450); else await mv(5, 5, 350);
          await settle(chip);
          const name = `${label}-${hov ? "hover" : "rest"}+${off}`;
          const r = await PXC.measure(win, { chip: `.side-panel:not(.closing) ${chip}`, glyph: `.side-panel:not(.closing) ${chip} svg`,
            css: `${hov ? `.side-panel ${chip} { box-shadow: none !important; } ` : ""}${css}`, png: off ? null : path.join(OUT, `side-pxc-${name.replace(/\+0$/, "")}.png`) });
          console.log(`        ${name}: ${r.error ?? `off by (${r.dx.toFixed(2)}, ${r.dy.toFixed(2)}) css px, glyph ${JSON.stringify(r.glyph)} in ${JSON.stringify(r.box)}`}`);
          v.push(...PXC.judge(name, r, tol));
        }
        await page(`document.getElementById("__pxoff")?.remove();`);
      };
      try {
        for (const [W0, H0] of sizes) {
          win.setContentSize(W0, H0); await sleep(700);
          const real = await js("devicePixelRatio");
          tol = Math.abs(real - Math.round(real)) < 1e-3 ? 0.5 : 1 / real + 0.02;
          const W = `${W0}@${real.toFixed(3).replace(/\.?0+$/, "")}`, H = `${H0}`;
          console.log(`        ${W0}x${H0} at devicePixelRatio ${real} (tolerance ${tol.toFixed(2)} css px)`);
          await page(`await m.closeAll(); await m.openSide("k2"); await m.sleep(400); const o = m.side().querySelector('[data-preview-src="image"]');
            if (o && o.getAttribute("aria-checked") !== "true") o.click(); await m.sleep(700);`);
          await one(`${W}x${H}-open`, "[data-side-open]", "svg", "");
          if (!await openVideo("k1")) { v.push(`${W}x${H}: k1 has no Video preview`); continue; }
          // paused, and past the layers' cross-fade (.28 s): nothing may change under the chip while it's measured
          await page(`m.side().querySelector('video[data-preview-layer="video"]')?.pause(); await m.sleep(700);`);
          // the video hidden under it while measured: a paused frame can still be redrawn between captures (seen at 2x)
          await one(`${W}x${H}-mute`, "[data-side-mute]", "svg", ".side-vol-slide, .side-panel .side-media > video { visibility: hidden !important; }");
        }
      } finally {
        win.setContentSize(1400, 900); await sleep(400); await mv(5, 5); await page(`await m.closeAll();`);
      }
      return v;
    });

    // lib:clearCrash:<on|off> — a crashed scene's notice and its Clear (LibrarySide.tsx clearCrash). s2 marked crashed in its
    // index entry shows the notice — a block of the body in the section cards' material with a danger stripe, the warning
    // glyph in --danger, its words and a .mini Clear, 12 px from its neighbours — and the whitelist row, and /apply refuses
    // it. A real click on Clear: the notice and the row fade out (in-between opacity frames; motion off: opacity only, nothing
    // moves); what sat after them takes their room (motion on: the action tiles and the Volume row glide through in-between
    // positions; off: at once); the mark is gone from the index, the card isn't marked, and (on) s2 plays: /apply → /current.
    // The hovered Clear glows (none under no-glow); under bg-live the notice keeps its own fill. Screenshots side-crash-*.png.
    const visibleGlow = (bs) => !!bs && bs !== "none" && !/^(rgba\(0, 0, 0, 0\)[^,]*)(, rgba\(0, 0, 0, 0\)[^,]*)*$/.test(bs);
    for (const mode of ["on", "off"]) await cell(`lib:clearCrash:${mode}`, async () => {
      const v = [], J = JSON.stringify;
      const scIdx = path.join(path.dirname(SC[1]), "index.json"), key = path.basename(SC[1]), idx0 = fs.readFileSync(scIdx, "utf8");
      const writeIdx = (j) => { fs.writeFileSync(scIdx + ".pb", typeof j === "string" ? j : JSON.stringify(j)); fs.renameSync(scIdx + ".pb", scIdx); };
      const cur0 = await current();
      try {
        const j = JSON.parse(idx0); j[key] = { ...(j[key] || {}), crashed: true }; writeIdx(j);
        await setSettings({ allowScenes: true });
        await loadUi(); if (mode === "off") await setMotion(false);
        await page(`await m.closeAll(); await m.openSide("s2"); await m.sleep(700);`);
        const pre = await page(`const s = m.side(), c = s.querySelector("[data-side-crash]"), b = s.querySelector("[data-side-crash-clear]");
          if (!c || !b) return { none: true, text: c?.textContent ?? null };
          const sec = s.querySelector(".side-sec"), cs = (e) => { const x = getComputedStyle(e); return { bg: x.backgroundColor, edge: x.borderTopColor, bw: x.borderTopWidth, radius: x.borderTopLeftRadius }; };
          const st = getComputedStyle(c, "::before"), d = document.createElement("div"); d.style.color = "var(--danger)"; document.body.appendChild(d); const danger = getComputedStyle(d).color; d.remove();
          const prev = c.previousElementSibling, next = c.nextElementSibling, r = c.getBoundingClientRect();
          return { text: c.textContent.trim(), btn: m.rect(b), mini: b.classList.contains("mini"), parent: c.parentElement.classList.contains("side-body"),
            mat: cs(c), secMat: cs(sec), stripe: { w: st.width, img: st.backgroundImage, left: st.left }, danger, ico: getComputedStyle(c.querySelector("svg")).color,
            gaps: [prev ? Math.round(r.top - prev.getBoundingClientRect().bottom) : null, next ? Math.round(next.getBoundingClientRect().top - r.bottom) : null],
            wl: !!s.querySelector(".side-wl"), card: !!m.card("s2")?.classList.contains("crashed") };`);
        if (pre.none) return [`s2 marked crashed: no crash notice with a Clear (${J(pre)}) — proved nothing`];
        console.log(`        ${J(pre)}`);
        if (!pre.parent) v.push("the notice isn't a block of the side body");
        if (!/crashed/i.test(pre.text) || !/rotations skip it/.test(pre.text)) v.push(`the notice says ${J(pre.text)}`);
        if (!pre.mini) v.push("Clear isn't the sidebar's small button (.mini)");
        if (J(pre.mat) !== J(pre.secMat)) v.push(`material ${J(pre.mat)}, the section cards' ${J(pre.secMat)}`);
        const dRgb = pre.danger.replace(/^rgba?\(|\)$/g, "").split(",").slice(0, 3).map((x) => x.trim()).join(", ");
        if (pre.stripe.w !== "3px" || pre.stripe.left !== "0px" || !pre.stripe.img.includes(dRgb)) v.push(`the left stripe isn't a 3 px --danger one (${J(pre.stripe)}, danger ${pre.danger})`);
        if (pre.ico !== pre.danger) v.push(`the glyph is ${pre.ico}, want --danger ${pre.danger}`);
        for (const g of pre.gaps) if (g != null && Math.abs(g - 12) > 1) v.push(`${g} px from a neighbour, want the body's 12 (${J(pre.gaps)})`);
        if (!pre.wl) v.push("s2 marked crashed: no whitelist row");
        if (!pre.card) v.push("s2's card isn't marked crashed");
        if (mode === "on") {
          // a user's own apply plays a crashed scene; only rotations skip it (PlayerHelper.Apply)
          const r = await post("/apply", { path: SC[1] });
          if (r.status >= 400) v.push(`while marked, /apply s2 answered ${r.status} ${J(r.json)} — a crashed scene still applies by hand`);
        }
        await mv(pre.btn.x + pre.btn.w / 2, pre.btn.y + pre.btn.h / 2, 400);
        const hov = await page(`const b = m.side().querySelector("[data-side-crash-clear]"), root = document.documentElement;
          const out = { glow: getComputedStyle(b).boxShadow }; root.classList.add("no-glow"); await m.sleep(250); out.noGlow = getComputedStyle(b).boxShadow; root.classList.remove("no-glow");
          const had = root.classList.contains("bg-live"); root.classList.add("bg-live"); await m.sleep(60);
          out.liveBg = getComputedStyle(m.side().querySelector("[data-side-crash]")).backgroundColor; if (!had) root.classList.remove("bg-live"); return out;`);
        if (!visibleGlow(hov.glow)) v.push(`glows on: the hovered Clear doesn't glow (${hov.glow})`);
        if (visibleGlow(hov.noGlow)) v.push(`no-glow: the hovered Clear still glows (${hov.noGlow})`);
        const a = /\/\s*([\d.]+)\s*\)/.exec(hov.liveBg)?.[1] ?? /rgba\([^)]*,\s*([\d.]+)\)/.exec(hov.liveBg)?.[1] ?? "1";
        if (+a < 0.3) v.push(`bg-live: the notice has no fill of its own (${hov.liveBg})`);
        if (mode === "on") {
          await shot("crash-hover");
          await page(`document.documentElement.classList.add("no-glow");`); await sleep(250); await shot("crash-noglow"); await page(`document.documentElement.classList.remove("no-glow");`);
        }
        const S = (sel) => `.side-panel:not(.closing) ${sel}`;
        const samp = js(MO.SAMPLE({ notice: S("[data-side-crash]"), wl: S(".side-wl"), tiles: S(".side-tiles"), vol: S('[data-side-row="volume"]') }, 1100));
        await sleep(40); await clickAt(pre.btn.x + pre.btn.w / 2, pre.btn.y + pre.btn.h / 2);
        await sleep(mode === "on" ? 120 : 60); await shot(`crash-clear-mid-${mode}`);
        const fr = await samp;
        await mv(5, 5); await sleep(300); await shot(`crash-cleared-${mode}`);
        console.log(`        motion ${mode}: notice ${MO.brief(fr.notice)} / row ${MO.brief(fr.wl)}`);
        v.push(...MO.judge("the notice", fr.notice, { leave: true, still: mode === "off", maxMs: mode === "on" ? 450 : 300 }));
        v.push(...MO.judge("the whitelist row", fr.wl, { leave: true, still: mode === "off", maxMs: mode === "on" ? 450 : 300 }));
        // what took their room: frames between its start and end position
        for (const [name, i] of [["the action tiles", "tiles"], ["the Volume row", "vol"]]) {
          const p = fr[i].filter((f) => f[1] != null).map((f) => f[3]);
          if (p.length < 2) { v.push(`${name}: not on screen — proved nothing`); continue; }
          const p0 = p[0], p1 = p[p.length - 1], d = p1 - p0;
          if (Math.abs(d) < 2) { v.push(`${name}: didn't move (${p0} → ${p1}) — proved nothing`); continue; }
          const mid = p.filter((x) => Math.min(Math.abs(x - p0), Math.abs(x - p1)) > 1 && (x - p0) * (p1 - x) > 0).length;
          console.log(`        ${name}: ${p0} → ${p1}, ${mid} frames between`);
          if (mode === "on" && mid < 2) v.push(`${name}: jumped ${d.toFixed(1)} px — no glide (${mid} frames between)`);
          if (mode === "off" && mid > 0) v.push(`motion off: ${name} glided (${mid} frames between) — it should take its place at once`);
        }
        const post1 = await page(`const s = m.side(); return { notice: !!s.querySelector("[data-side-crash]"), wl: !!s.querySelector(".side-wl"), card: !!m.card("s2")?.classList.contains("crashed") };`);
        if (post1.notice || post1.wl) v.push(`after Clear: still showing ${J(post1)}`);
        if (post1.card) v.push("after Clear: s2's card is still marked crashed");
        const m1 = JSON.parse(fs.readFileSync(scIdx, "utf8"))[key];
        if (m1?.crashed) v.push(`after Clear: s2's index entry still crashed (${J(m1)})`);
        if (mode === "on") {
          const r = await post("/apply", { path: SC[1] });
          if (r.status !== 200) v.push(`after Clear, /apply s2 answered ${r.status} ${J(r.json)}`);
          let cur = null; for (let i = 0; i < 40 && (cur = await current()) !== SC[1]; i++) await sleep(200);
          if (cur !== SC[1]) v.push(`after Clear, s2 doesn't play (/current ${T(cur)})`);
        }
      } finally {
        writeIdx(idx0);
        await setSettings({ allowScenes: false });
        if (cur0) await post("/apply", { path: cur0 }); else await post("/stop");
        await sleep(800);
        await mv(5, 5); if (mode === "off") await setMotion(true);
        await loadUi();
      }
      return v;
    });

    // lib:clearCrash:multi — Clear on a selection lifts every selected item's mark, as the selection's other actions repeat to
    // all of it (LibrarySide.tsx clearCrash). s1 and s2 marked crashed and k1 (no mark) Ctrl-selected, the sidebar opened on s2
    // with a right-click: one real click on Clear → neither index entry is crashed, neither card is marked, k1 is untouched.
    await cell("lib:clearCrash:multi", async () => {
      const v = [], J = JSON.stringify;
      const scIdx = path.join(path.dirname(SC[1]), "index.json"), keys = [path.basename(SC[0]), path.basename(SC[1])], idx0 = fs.readFileSync(scIdx, "utf8");
      const writeIdx = (j) => { fs.writeFileSync(scIdx + ".pb", typeof j === "string" ? j : JSON.stringify(j)); fs.renameSync(scIdx + ".pb", scIdx); };
      if (path.dirname(SC[0]) !== path.dirname(SC[1])) return [`s1 and s2 live in different libraries — proved nothing`];
      try {
        const j = JSON.parse(idx0); for (const k of keys) j[k] = { ...(j[k] || {}), crashed: true }; writeIdx(j);
        await setSettings({ allowScenes: true });
        await loadUi();
        await page(`await m.closeAll(); for (const t of ["s1", "s2", "k1"]) { m.thumb(t).dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true })); await m.sleep(250); }
          m.ctx(m.thumb("s2")); await m.waitSide("library"); await m.sleep(700);`);
        const pre = await page(`const b = m.side()?.querySelector("[data-side-crash-clear]");
          return { btn: b ? m.rect(b) : null, head: m.side()?.querySelector(".side-head")?.textContent ?? "", marked: ["s1", "s2"].map((t) => !!m.card(t)?.classList.contains("crashed")),
            sel: document.querySelectorAll(".card.lib.selected").length };`);
        console.log(`        ${J(pre)}`);
        if (!pre.btn) return [`s2 marked crashed in a selection: no Clear (${J(pre)}) — proved nothing`];
        if (pre.sel !== 3 || !/3 selected/.test(pre.head)) return [`the selection isn't s1, s2 and k1 (${pre.sel} selected, head ${J(pre.head.slice(0, 80))}) — proved nothing`];
        if (!pre.marked.every(Boolean)) return [`s1 / s2 cards not both marked before Clear (${J(pre.marked)}) — proved nothing`];
        const txt = await page(`return m.side()?.querySelector("[data-side-crash-text]")?.textContent ?? m.side()?.querySelector("[data-side-crash]")?.textContent ?? null;`);
        if (!/^2 selected scenes crashed the player/.test(txt ?? "")) v.push(`two marked in the selection: the notice reads ${J(txt)} (want "2 selected scenes crashed the player…")`);
        await shot("crash-multi");
        await mv(pre.btn.x + pre.btn.w / 2, pre.btn.y + pre.btn.h / 2, 300);
        await clickAt(pre.btn.x + pre.btn.w / 2, pre.btn.y + pre.btn.h / 2);
        await sleep(900); await shot("crash-cleared-multi");
        const post1 = await page(`return { marked: ["s1", "s2"].map((t) => !!m.card(t)?.classList.contains("crashed")), notice: !!m.side()?.querySelector("[data-side-crash]"),
          sel: document.querySelectorAll(".card.lib.selected").length };`);
        if (post1.notice) v.push("after Clear: the notice still shows");
        if (post1.marked[0]) v.push("after Clear on the selection: s1's card is still marked crashed (only the clicked item was cleared)");
        if (post1.marked[1]) v.push("after Clear: s2's card is still marked crashed");
        if (post1.sel !== 3) v.push(`Clear changed the selection (${post1.sel} selected, want 3)`);
        const after = JSON.parse(fs.readFileSync(scIdx, "utf8"));
        keys.forEach((k, i) => { if (after[k]?.crashed) v.push(`after Clear: s${i + 1}'s index entry still crashed (${J(after[k])})`); });
      } finally {
        writeIdx(idx0);
        await setSettings({ allowScenes: false });
        await mv(5, 5); await page(`m.key("Escape"); await m.sleep(300); await m.closeAll();`);
        await loadUi();
      }
      return v;
    });

    // lib:clearCrash:others — the notice shows for a mark Clear would lift though the open item has none: s1 marked, s1 and k1
    // Ctrl-selected, the sidebar opened on k1. "1 selected scene crashed the player", no whitelist row (it is s1's own setting);
    // a real click on Clear → s1's index entry and card unmarked, the notice fades out (in-between opacity frames, motion on
    // and off), the selection stays.
    for (const mode of ["on", "off"]) await cell(`lib:clearCrash:others:${mode}`, async () => {
      const v = [], J = JSON.stringify;
      const scIdx = path.join(path.dirname(SC[0]), "index.json"), key = path.basename(SC[0]), idx0 = fs.readFileSync(scIdx, "utf8");
      const writeIdx = (j) => { fs.writeFileSync(scIdx + ".pb", typeof j === "string" ? j : JSON.stringify(j)); fs.renameSync(scIdx + ".pb", scIdx); };
      try {
        const j = JSON.parse(idx0); j[key] = { ...(j[key] || {}), crashed: true }; writeIdx(j);
        await setSettings({ allowScenes: true });
        await loadUi(); if (mode === "off") await setMotion(false);
        await page(`await m.closeAll(); for (const t of ["s1", "k1"]) { m.thumb(t).dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true })); await m.sleep(250); }
          m.ctx(m.thumb("k1")); await m.waitSide("library"); await m.sleep(700);`);
        const pre = await page(`const s = m.side(), b = s?.querySelector("[data-side-crash-clear]");
          return { btn: b ? m.rect(b) : null, text: s?.querySelector("[data-side-crash]")?.textContent?.trim() ?? null, wl: !!s?.querySelector(".side-wl"),
            sel: document.querySelectorAll(".card.lib.selected").length, marked: !!m.card("s1")?.classList.contains("crashed") };`);
        console.log(`        ${J(pre)}`);
        if (pre.sel !== 2 || !pre.marked) return [`the selection isn't s1 (marked) + k1 (${J(pre)}) — proved nothing`];
        if (!pre.btn) return [`s1 marked in the selection, the sidebar on k1: no crash notice (${J(pre)})`];
        if (!/^1 selected scene crashed the player/.test(pre.text ?? "")) v.push(`the notice reads ${J(pre.text)} (want "1 selected scene crashed the player…")`);
        if (pre.wl) v.push("k1 has no mark: a whitelist row shows (s1's own setting)");
        if (mode === "on") await shot("crash-others");
        await mv(pre.btn.x + pre.btn.w / 2, pre.btn.y + pre.btn.h / 2, 300);
        const samp = js(MO.SAMPLE({ notice: ".side-panel:not(.closing) [data-side-crash]" }, 900));
        await sleep(40); await clickAt(pre.btn.x + pre.btn.w / 2, pre.btn.y + pre.btn.h / 2);
        const fr = await samp;
        v.push(...MO.judge("the notice", fr.notice, { leave: true, still: mode === "off", maxMs: mode === "on" ? 450 : 300 }));
        await sleep(300);
        const post1 = await page(`return { notice: !!m.side()?.querySelector("[data-side-crash]"), marked: !!m.card("s1")?.classList.contains("crashed"), sel: document.querySelectorAll(".card.lib.selected").length };`);
        if (post1.notice) v.push("after Clear: the notice still shows");
        if (post1.marked) v.push("after Clear: s1's card is still marked crashed");
        if (post1.sel !== 2) v.push(`Clear changed the selection (${post1.sel} selected, want 2)`);
        if (JSON.parse(fs.readFileSync(scIdx, "utf8"))[key]?.crashed) v.push("after Clear: s1's index entry still crashed");
      } finally {
        writeIdx(idx0);
        await setSettings({ allowScenes: false });
        await mv(5, 5); await page(`m.key("Escape"); await m.sleep(300); await m.closeAll();`);
        if (mode === "off") await setMotion(true);
        await loadUi();
      }
      return v;
    });

    // lib:fontStandIn:<on|off> — a scene font this machine doesn't have, end to end (LibrarySide.tsx fontNote): s2's synthetic
    // worker reports "Consolas shown with Cascadia Mono" in its Ready (its spec's `fonts`, as a real scene's fontconfig match
    // would), the player's scene.fonts reaches the backend, the index keeps it and library-item-changed tells the page. With
    // s2's sidebar open, a play of s2 brings one muted line "Uses Consolas, shown with Cascadia Mono" in the Playback section
    // (the loudness note's style: the theme's muted text, no glow), fading in where it stays (motion off: opacity only, nothing
    // moves); a later play whose fonts are all installed (an empty report) clears the index and the line fades out.
    // Screenshots side-fonts-*.png (on, no-glow, bg-live).
    for (const mode of ["on", "off"]) await cell(`lib:fontStandIn:${mode}`, async () => {
      const v = [], J = JSON.stringify;
      const spec = path.join(SC[1], "liascape-synthetic.json"), spec0 = fs.readFileSync(spec, "utf8");
      const scIdx = path.join(path.dirname(SC[1]), "index.json"), key = path.basename(SC[1]), idx0 = fs.readFileSync(scIdx, "utf8");
      const writeIdx = (s) => { fs.writeFileSync(scIdx + ".pb", s); fs.renameSync(scIdx + ".pb", scIdx); };
      const cur0 = await current();
      const playFresh = async () => {
        // another scene first: s2's next play is a new worker load (its Ready reports its fonts)
        for (const p of [SC[0], SC[1]]) {
          const r = await post("/apply", { path: p });
          if (r.status >= 400) v.push(`/apply ${T(p)} answered ${r.status} ${J(r.json)}`);
          let cur = null; for (let i = 0; i < 50 && (cur = await current()) !== p; i++) await sleep(200);
          if (cur !== p) v.push(`${T(p)} doesn't play (/current ${T(cur)})`);
        }
      };
      const S = (sel) => `.side-panel:not(.closing) ${sel}`;
      try {
        const j = JSON.parse(idx0); if (j[key]) delete j[key].fontStandIns; writeIdx(JSON.stringify(j));
        fs.writeFileSync(spec, J({ ...JSON.parse(spec0), fonts: [{ font: "Consolas", shown: "Cascadia Mono" }] }));
        await setSettings({ allowScenes: true });
        await loadUi(); if (mode === "off") await setMotion(false);
        await page(`await m.closeAll(); await m.openSide("s2"); await m.sleep(700);`);
        if (await page(`return !!m.side()?.querySelector("[data-scene-fonts]")`)) return ["s2 shows a font line before any report — proved nothing"];
        const inF = js(MO.SAMPLE({ line: S("[data-scene-fonts]"), vol: S('[data-side-row="volume"]') }, 9000));
        await sleep(40); await playFresh();
        const fr = await inF;
        console.log(`        motion ${mode}: line ${MO.brief(fr.line)}`);
        v.push(...MO.judge("the font line", fr.line, { appear: true, still: mode === "off", maxMs: mode === "on" ? 450 : 300 }));
        if (mode === "on") {
          // it rises into place as it fades in (index.css side-pill-in), never jumps
          const ys = fr.line.filter((f) => f[1] != null && f[1] > 0.02).map((f) => f[3]);
          if (ys.length < 2 || !(ys[0] > ys[ys.length - 1] + 1)) v.push(`motion on: the line didn't rise into place (${J(ys.slice(0, 6))} … ${ys[ys.length - 1]})`);
        }
        await mv(5, 5); await sleep(300);
        const got = await page(`const s = m.side(), l = s?.querySelector("[data-scene-fonts]"); if (!l) return { none: true };
          const sec = l.closest(".side-sec"), note = document.createElement("div"); note.className = "shint side-note"; sec.appendChild(note);
          const ref = getComputedStyle(note).color; note.remove(); const cs = getComputedStyle(l);
          return { text: l.textContent.trim(), sec: sec?.dataset.sec ?? null, color: cs.color, ref, shadow: cs.boxShadow, tshadow: cs.textShadow };`);
        console.log(`        ${J(got)}`);
        if (got.none) return [...v, "no font line after s2 played with a stand-in"];
        if (got.text !== "Uses Consolas, shown with Cascadia Mono") v.push(`the line says ${J(got.text)}`);
        if (got.sec !== "playback") v.push(`the line sits in the ${J(got.sec)} section, want Playback`);
        if (got.color !== got.ref) v.push(`the line's colour ${got.color} isn't the muted note's ${got.ref}`);
        if (got.shadow !== "none") v.push(`the line glows (${got.shadow})`);
        const m1 = JSON.parse(fs.readFileSync(scIdx, "utf8"))[key];
        if (J(m1?.fontStandIns) !== J([{ font: "Consolas", shown: "Cascadia Mono" }])) v.push(`s2's index entry keeps ${J(m1?.fontStandIns)}`);
        const it = await libItem(SC[1]);
        if (J(it?.fontStandIns) !== J([{ font: "Consolas", shown: "Cascadia Mono" }])) v.push(`GET /library's s2 says ${J(it?.fontStandIns)}`);
        if (mode === "on") {
          await shot("fonts-on");
          await page(`document.documentElement.classList.add("no-glow");`); await sleep(250); await shot("fonts-noglow");
          await page(`document.documentElement.classList.remove("no-glow"); document.documentElement.classList.add("bg-live");`); await sleep(250);
          await shot("fonts-bglive"); await page(`document.documentElement.classList.remove("bg-live");`);
        }
        // every font installed now: the next play reports none, the line leaves
        fs.writeFileSync(spec, spec0);
        const outF = js(MO.SAMPLE({ line: S("[data-scene-fonts]") }, 9000));
        await sleep(40); await playFresh();
        const fo = await outF;
        v.push(...MO.judge("the font line", fo.line, { leave: true, still: mode === "off", maxMs: mode === "on" ? 450 : 300 }));
        if (await page(`return !!m.side()?.querySelector("[data-scene-fonts]")`)) v.push("the line stays after a play with every font installed");
        const m2 = JSON.parse(fs.readFileSync(scIdx, "utf8"))[key];
        if (m2?.fontStandIns) v.push(`an empty report left s2's index with ${J(m2.fontStandIns)}`);
      } finally {
        fs.writeFileSync(spec, spec0);
        writeIdx(idx0);
        await setSettings({ allowScenes: false });
        if (cur0) await post("/apply", { path: cur0 }); else await post("/stop");
        await sleep(800);
        await mv(5, 5); if (mode === "off") await setMotion(true);
        await loadUi();
      }
      return v;
    });

    // ---- "Scene properties" folds (ScenePropsEditor.tsx; store scenePropsFolded, localStorage). s1's fixture: color, clock and
    // bars (shown while clock is on). A second scene with properties for the remembered choice and the count: s2's
    // project.json, rewritten for these cells (a group heading, a label, a toggle and a slider hidden by its condition).
    const FOLD_KEY = "liascape.scenePropsFolded";
    const S2_PROPS = { look: { order: 0, text: "Look", type: "group" }, speed: { order: 1, text: "Spin speed", type: "slider", value: 2, min: 0, max: 10, fraction: false },
      about: { order: 2, text: "Tuned for dark themes" }, show: { order: 3, text: "Show rings", type: "bool", value: false },
      rings: { order: 4, text: "Rings", type: "slider", value: 3, min: 1, max: 8, fraction: false, condition: "show.value" } };
    const withS2Props = async (fn) => {
      const pj = path.join(SC[1], "project.json"), pj0 = fs.readFileSync(pj, "utf8");
      const j = JSON.parse(pj0); j.general = { ...(j.general || {}), properties: S2_PROPS };
      fs.writeFileSync(pj + ".pb", JSON.stringify(j)); fs.renameSync(pj + ".pb", pj);
      try { return await fn(); } finally { fs.writeFileSync(pj + ".pb", pj0); fs.renameSync(pj + ".pb", pj); }
    };
    const foldHead = () => page(`const s = m.side()?.querySelector("[data-scene-props]"); const b = s?.querySelector("[data-scene-props-head]");
      if (!b) return null; const r = b.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, tag: b.tagName, exp: b.getAttribute("aria-expanded"), body: !!s.querySelector("[data-scene-props-body]"),
        count: s.querySelector("[data-scene-props-count]")?.textContent.trim() ?? null, text: b.textContent.replace(/\\s+/g, " ").trim(),
        rows: s.querySelectorAll(".srow[data-scene-prop]").length, shown: s.querySelectorAll("[data-scene-prop]").length };`);
    // the section on `t`'s sidebar: true with its fold header; a reason when it's missing, or has no header to fold it
    const waitProps = async (t) => {
      const r = await page(`for (let i = 0; i < 60; i++) { const s = m.sideTitle() === ${JSON.stringify(t)} ? m.side()?.querySelector("[data-scene-props]") : null;
        if (s?.querySelector("[data-scene-props-head]")) return "ok"; if (s && i > 20) return "nohead"; await m.sleep(50); } return "none";`);
      if (r === "ok") return true;
      throw new Error(r === "nohead" ? `${t}'s Scene properties have no fold header (a button with aria-expanded and the count)` : `${t}'s sidebar shows no Scene properties — proved nothing`);
    };
    // every frame for `ms`: the section's box, its head's, the first row's opacity and box, the chevron's turn, what sits below
    // (a probe block after the section in the body) and the properties any running animation in the section animates
    const FOLD_SAMPLE = (ms) => `(() => new Promise((res) => { const out = [], props = new Set(); const t0 = performance.now();
      const f = () => { const s = document.querySelector(".side-panel:not(.closing) [data-scene-props]");
        if (s) { const h = s.querySelector("[data-scene-props-head]"), row = s.querySelector(".srow[data-scene-prop]"), ch = s.querySelector(".sp-chev"), bl = document.querySelector("[data-probe-below]");
          for (const a of s.getAnimations({ subtree: true })) for (const k of a.effect?.getKeyframes?.() ?? []) for (const p of Object.keys(k)) if (!["offset", "easing", "composite", "computedOffset"].includes(p)) props.add(p);
          const r = s.getBoundingClientRect(), hr = h.getBoundingClientRect(), tf = getComputedStyle(ch).transform, mx = new DOMMatrix(tf === "none" ? undefined : tf);
          let op = null, rr = null; if (row && row.getClientRects().length) { op = 1; for (let e = row; e && e.nodeType === 1; e = e.parentElement) op *= +getComputedStyle(e).opacity; rr = row.getBoundingClientRect(); }
          out.push({ t: Math.round(performance.now() - t0), h: +r.height.toFixed(1), y: +r.y.toFixed(1), hx: +hr.x.toFixed(1), hy: +hr.y.toFixed(1), hh: +hr.height.toFixed(1),
            op: op == null ? null : +op.toFixed(3), ry: rr ? +rr.y.toFixed(1) : null, rh: rr ? +rr.height.toFixed(1) : null,
            rot: +(Math.atan2(mx.b, mx.a) * 180 / Math.PI).toFixed(1), by: bl ? +bl.getBoundingClientRect().y.toFixed(1) : null }); }
        if (performance.now() - t0 < ${ms}) requestAnimationFrame(f); else res({ out, props: [...props] }); };
      requestAnimationFrame(f); }))()`;
    // frames strictly between a series' first and last value (more than `tol` from both)
    const between = (xs, tol = 1) => { const a = xs[0], b = xs[xs.length - 1]; return xs.filter((x) => Math.min(Math.abs(x - a), Math.abs(x - b)) > tol && (x - a) * (b - x) > 0).length; };
    const spread = (xs) => Math.max(...xs) - Math.min(...xs);
    // what's wrong with one fold (collapse or expand), frame by frame
    function judgeFold(dir, mode, f, props) {
      const v = [], J = JSON.stringify, on = mode === "on";
      if (f.length < 5) return [`${dir}: ${f.length} frames sampled — proved nothing`];
      const hs = f.map((x) => x.h), d = hs[hs.length - 1] - hs[0];
      if (dir === "collapse" ? d > -10 : d < 10) return [`${dir}: the section went ${hs[0]} → ${hs[hs.length - 1]} px — nothing folded (proved nothing)`];
      const hb = between(hs), rots = f.map((x) => x.rot), rb = between(rots, 2), ops = f.map((x) => x.op);
      console.log(`        ${mode} ${dir}: height ${hs[0]} → ${hs[hs.length - 1]} (${hb} frames between), chevron ${rots[0]}° → ${rots[rots.length - 1]}° (${rb} between), row opacity ${ops.map((x) => (x == null ? "-" : x.toFixed(2))).filter((x, i, a) => !i || x !== a[i - 1]).slice(0, 12).join(" ")}, animated ${J(props)}`);
      // the box: through in-between heights (on), at once (off)
      if (on && hb < 3) v.push(`${dir}: the box jumped ${hs[0]} → ${hs[hs.length - 1]} px (${hb} frames between) — it should morph`);
      if (!on && hb > 0) v.push(`motion ${mode}, ${dir}: the box went through ${hb} in-between heights — it should take its size at once`);
      // the head never moves or stretches (on: it rides the morph unscaled)
      const hx = f.map((x) => x.hx), hy = f.map((x) => x.hy), hh = f.map((x) => x.hh);
      if (spread(hx) > 0.75 || spread(hy) > 0.75) v.push(`${dir}: the head moved (x ${Math.min(...hx)}–${Math.max(...hx)}, y ${Math.min(...hy)}–${Math.max(...hy)}; t:y ${f.map((x) => `${x.t}:${x.hy}`).join(" ")})`);
      if (spread(hh) > 1) v.push(`${dir}: the head's height went ${Math.min(...hh)}–${Math.max(...hh)} px — it was stretched with the box`);
      // the chevron turns: through in-between angles (on), at once (off); right while folded, down while open
      const want = dir === "collapse" ? -90 : 0;
      if (Math.abs(rots[rots.length - 1] - want) > 1) v.push(`${dir}: the chevron ends at ${rots[rots.length - 1]}°, want ${want}°`);
      if (on && rb < 2) v.push(`${dir}: the chevron didn't turn (${rb} in-between angles: ${rots[0]}° → ${rots[rots.length - 1]}°)`);
      if (!on && rb > 0) v.push(`motion ${mode}, ${dir}: the chevron turned through ${rb} angles — it should turn at once`);
      // the rows fade (in-between opacity frames, never a pop)
      const last = ops[ops.length - 1], mid = ops.filter((o) => o != null && o > 0.02 && o < 0.95).length;
      if (dir === "collapse" ? last != null : last == null || last < 0.95) v.push(`${dir}: the rows ended at opacity ${last}`);
      if (!mid) v.push(`${dir}: the rows ${dir === "collapse" ? "popped out" : "popped in"} — no in-between opacity frame`);
      // a row while it shows: never stretched; with motion off, never moved
      const rows = f.filter((x) => x.op != null && x.op > 0.02);
      if (rows.length && spread(rows.map((x) => x.rh)) > 1) v.push(`${dir}: a row's height went ${Math.min(...rows.map((x) => x.rh))}–${Math.max(...rows.map((x) => x.rh))} px — stretched with the box`);
      if (!on && rows.length && spread(rows.map((x) => x.ry)) > 0.75) v.push(`motion ${mode}, ${dir}: a row moved while it faded (y ${Math.min(...rows.map((x) => x.ry))}–${Math.max(...rows.map((x) => x.ry))})`);
      // what sits below: glides (on), takes its place at once (off)
      const bys = f.map((x) => x.by).filter((x) => x != null);
      if (bys.length < 2 || Math.abs(bys[bys.length - 1] - bys[0]) < 10) v.push(`${dir}: the block below didn't move (${bys[0]} → ${bys[bys.length - 1]}) — proved nothing`);
      else {
        const bb = between(bys);
        if (on && bb < 3) v.push(`${dir}: the block below jumped ${bys[0]} → ${bys[bys.length - 1]} (${bb} frames between) — it should glide`);
        if (!on && bb > 0) v.push(`motion ${mode}, ${dir}: the block below glided (${bb} frames between) — it should move at once`);
      }
      // what animates: opacity alone with motion off; never a layout property
      const bad = props.filter((p) => (on ? /^(height|width|top|left|right|bottom|margin|padding|max-height|min-height)/.test(p) : p !== "opacity"));
      if (bad.length) v.push(`motion ${mode}, ${dir}: animates ${J(bad)}${on ? " (a layout property)" : " (only opacity may change)"}`);
      return v;
    }
    // lib:propsFold:<on|off|reduced> — the header (a real button with aria-expanded, "Scene properties · 3") folds s1's section
    // with a real click and opens it again, sampled per frame: motion on, the box morphs through in-between heights, the head
    // stays put and unstretched, the chevron turns through in-between angles, the rows fade, a block below glides; off /
    // reduced motion: only opacity animates, the box and the block below change at once, the chevron turns at once. On: the
    // chevron glows on hover (none under no-glow), the folded card keeps its fill under bg-live. Screenshots side-fold-*.png
    for (const mode of ["on", "off", "reduced"]) await cell(`lib:propsFold:${mode}`, async () => {
      const v = [], J = JSON.stringify;
      try {
        await page(`localStorage.removeItem("${FOLD_KEY}");`); await loadUi();
        if (mode === "off") await setMotion(false);
        if (mode === "reduced") await reducedMotion(true);
        await page(`await m.closeAll(); await m.openSide("s1");`);
        await waitProps("s1");
        await sleep(600);
        const h0 = await foldHead();
        console.log(`        ${J(h0)}`);
        if (h0.tag !== "BUTTON") v.push(`the header is a <${h0.tag}>, not a button`);
        if (h0.exp !== "true" || !h0.body) return [...v, `s1's properties don't start open (${J(h0)})`];
        if (!/^Scene properties · 3$/i.test(h0.text)) v.push(`the header reads ${J(h0.text)}, want "Scene properties · 3"`);
        // a block after the section, where a later section would sit (React leaves a node it didn't make alone)
        await page(`const b = document.createElement("div"); b.dataset.probeBelow = ""; b.style.cssText = "height: 24px; border: 1px dashed var(--accent)";
          m.side().querySelector(".side-body").appendChild(b); m.side().querySelector(".side-scroll").scrollTop = 0;`);
        await sleep(200);
        if (mode === "on") {
          await mv(h0.x, h0.y, 450);
          const g = await page(`const c = m.side().querySelector(".sp-chev"), root = document.documentElement; const out = { glow: getComputedStyle(c).filter };
            root.classList.add("no-glow"); await m.sleep(300); out.noGlow = getComputedStyle(c).filter; return out;`);
          await shot("fold-noglow-hover"); await page(`document.documentElement.classList.remove("no-glow");`);
          if (!/drop-shadow/.test(g.glow)) v.push(`the hovered header's chevron doesn't glow (${g.glow})`);
          if (g.noGlow !== "none") v.push(`no-glow: the hovered chevron still glows (${g.noGlow})`);
        }
        const H = await foldHead();
        for (const dir of ["collapse", "expand"]) {
          const samp = js(FOLD_SAMPLE(900));
          await sleep(40); await clickAt(H.x, H.y);
          await sleep(mode === "on" ? 110 : 50); await shot(`fold-${mode}-${dir}-mid`);
          const fr = await samp;
          await sleep(200); await shot(`fold-${mode}-${dir === "collapse" ? "folded" : "open"}`);
          const st = await foldHead();
          if (st.exp !== String(dir === "expand") || st.body !== (dir === "expand")) v.push(`after the ${dir}: aria-expanded ${st.exp}, body ${st.body}`);
          v.push(...judgeFold(dir, mode, fr.out, fr.props));
          if (dir === "collapse" && mode === "on") {
            await mv(5, 5, 300);
            const live = await page(`const root = document.documentElement, had = root.classList.contains("bg-live"); root.classList.add("bg-live"); await m.sleep(80);
              return { bg: getComputedStyle(m.side().querySelector("[data-scene-props]")).backgroundColor, had };`);
            await shot("fold-bglive-folded");
            if (!live.had) await page(`document.documentElement.classList.remove("bg-live");`);
            const a = /\/\s*([\d.]+)\s*\)/.exec(live.bg)?.[1] ?? /rgba\([^)]*,\s*([\d.]+)\)/.exec(live.bg)?.[1] ?? "1";
            if (+a < 0.3) v.push(`bg-live: the folded section has no fill of its own (${live.bg})`);
            await mv(H.x, H.y, 300);
          }
        }
      } finally {
        await page(`document.querySelector("[data-probe-below]")?.remove(); localStorage.removeItem("${FOLD_KEY}");`).catch(() => {});
        await mv(5, 5);
        if (mode === "off") await setMotion(true);
        if (mode === "reduced") await reducedMotion(false);
        await loadUi();
      }
      return v;
    });

    // lib:propsFoldKeys — Enter on the focused header folds, Space opens (real key events): no card applies, the sidebar
    // stays open on s1
    await cell("lib:propsFoldKeys", async () => {
      const v = [];
      try {
        await page(`localStorage.removeItem("${FOLD_KEY}");`); await loadUi();
        await page(`await m.closeAll(); await m.openSide("s1");`);
        await waitProps("s1");
        await sleep(500);
        const cur0 = await current();
        await page(`m.side().querySelector("[data-scene-props-head]").focus();`);
        if (!await page(`return document.activeElement?.matches("[data-scene-props-head]") ?? false;`)) return ["the header can't take the focus"];
        for (const [key, want] of [["Return", "false"], ["Space", "true"]]) {
          send({ type: "keyDown", keyCode: key }); if (key === "Return") send({ type: "char", keyCode: "\r" }); await sleep(30); send({ type: "keyUp", keyCode: key });
          await sleep(700);
          const st = await foldHead();
          console.log(`        ${key}: aria-expanded ${st?.exp}, body ${st?.body}, sidebar on ${await page(`return m.sideTitle();`)}`);
          if (st?.exp !== want) v.push(`${key === "Return" ? "Enter" : "Space"} on the header: aria-expanded ${st?.exp}, want ${want}`);
        }
        if (await page(`return m.sideTitle();`) !== "s1") v.push("the keys moved or closed the sidebar");
        if ((await current()) !== cur0) v.push(`a key applied a wallpaper (${T(cur0)} → ${T(await current())})`);
      } finally { await page(`localStorage.removeItem("${FOLD_KEY}");`).catch(() => {}); }
      return v;
    });

    // lib:propsFoldKeep — the fold is one choice for every scene: folded on s1, s2's sidebar (a switch) opens folded, and a
    // reload keeps it (no row shows on the way); opened on s2, s1 opens open
    await cell("lib:propsFoldKeep", async () => withS2Props(async () => {
      const v = [], J = JSON.stringify;
      try {
        await page(`localStorage.removeItem("${FOLD_KEY}");`); await loadUi();
        await page(`await m.closeAll(); await m.openSide("s1");`);
        await waitProps("s1");
        await sleep(500);
        let h = await foldHead();
        if (h.exp !== "true") return [`s1 doesn't start open (${J(h)})`];
        await clickAt(h.x, h.y); await sleep(700);
        h = await foldHead();
        if (h.exp !== "false") return [`a click didn't fold s1 (${J(h)})`];
        const ls = await page(`return localStorage.getItem("${FOLD_KEY}");`);
        if (ls !== "true") v.push(`localStorage ${FOLD_KEY} = ${J(ls)} after folding, want "true"`);
        // another scene's sidebar: the sidebar moves to s2
        await page(`m.ctx(m.thumb("s2"));`);
        await waitProps("s2");
        await sleep(600);
        h = await foldHead();
        console.log(`        s2 after folding s1: ${J(h)}`);
        if (h.exp !== "false" || h.body) v.push(`s2 opened ${h.exp === "true" ? "open" : "folded"}${h.body ? " with its rows" : ""} after folding s1 — the choice is per item`);
        await shot("fold-keep-s2");
        // a reload
        await loadUi(); await page(`await m.closeAll(); m.ctx(m.thumb("s1"));`);
        const fr = await js(FOLD_SAMPLE(1200));
        h = await foldHead();
        console.log(`        s1 after a reload: ${J(h)}`);
        if (!fr.out.length) v.push("after a reload s1 shows no Scene properties section — proved nothing");
        if (h?.exp !== "false" || h?.body) v.push(`after a reload s1 opened ${h?.exp === "true" ? "open" : "folded"} — the choice wasn't kept`);
        if (fr.out.some((x) => x.op != null)) v.push("after a reload a row of the folded section showed");
        // opened on s2 → open on s1 too
        await page(`m.ctx(m.thumb("s2"));`); await waitProps("s2"); await sleep(600);
        h = await foldHead(); await clickAt(h.x, h.y); await sleep(700);
        await page(`m.ctx(m.thumb("s1"));`); await waitProps("s1"); await sleep(600);
        h = await foldHead();
        if (h.exp !== "true" || !h.body) v.push(`opened on s2, s1 shows ${h.exp === "true" ? "open" : "folded"}`);
      } finally { await page(`localStorage.removeItem("${FOLD_KEY}");`).catch(() => {}); }
      return v;
    }));

    // lib:propsCount — the header counts the properties the editor shows: s1 "· 3" (color, clock, bars), "· 2" once clock is
    // off (bars hides by its condition; a real click on the checkbox) and "· 3" again; s2 "· 2" (its group heading and label
    // aren't properties, rings is hidden by its condition). Read late (held 900 ms, past the body's wait), the header shows
    // once with its count: its title, count and chevron never move or change in the card after that
    await cell("lib:propsCount", async () => withS2Props(async () => {
      const v = [], J = JSON.stringify;
      try {
        await page(`localStorage.removeItem("${FOLD_KEY}");`); await loadUi();
        await page(`await m.closeAll(); await m.openSide("s1");`);
        await waitProps("s1");
        await sleep(500);
        const c0 = await foldHead();
        if (c0.count !== "· 3" || c0.rows !== 3) v.push(`s1: count ${J(c0.count)} over ${c0.rows} rows, want "· 3" over 3`);
        // found again before each click: bars hiding shortens the sidebar, which can scroll the checkbox
        const clock = () => page(`const r = m.side().querySelector('[data-scene-prop="clock"] input[type=checkbox]'); if (!r) return null; r.scrollIntoView({ block: "nearest" }); await m.sleep(200); return m.rect(r);`);
        for (const want of ["· 2", "· 3"]) {
          const ck = await clock();
          if (!ck) return [...v, "s1 has no clock checkbox — proved nothing"];
          await clickAt(ck.x + ck.w / 2, ck.y + ck.h / 2);
          let c = null; for (let i = 0; i < 30; i++) { c = await foldHead(); if (c.count === want) break; await sleep(100); }
          const bars = await page(`return !!m.side().querySelector('[data-scene-prop="bars"]');`);
          const st = want === "· 2" ? "off" : "on";
          console.log(`        clock ${st}: count ${J(c.count)}, ${c.rows} rows, bars ${bars ? "shown" : "hidden"}`);
          if (c.count !== want) v.push(`clock ${st}: the count reads ${J(c.count)}, want ${J(want)}`);
          if (+want.slice(2) !== c.rows) v.push(`clock ${st}: ${c.rows} rows shown, the count says ${c.count}`);
        }
        await post("/library/scene-props", { path: SC[0], reset: true });
        // s2, read late: the body shows first (its wait is capped), the section with its count after it
        await loadUi();
        await page(`const f0 = window.fetch; window.fetch = (u, o) => String(u).includes("/library/scene-props?") ? new Promise((r) => setTimeout(r, 900)).then(() => f0(u, o)) : f0(u, o);
          await m.closeAll(); m.ctx(m.thumb("s2"));`);
        const fr = await page(`const out = []; const t0 = performance.now();
          await new Promise((res) => { const f = () => { const s = m.side()?.querySelector("[data-scene-props]");
            if (s) { const sr = s.getBoundingClientRect(), b = s.querySelector("[data-scene-props-head]"), br = b.getBoundingClientRect(), c = s.querySelector("[data-scene-props-count]"), cr = c.getBoundingClientRect(), ch = s.querySelector(".sp-chev").getBoundingClientRect();
              out.push({ t: Math.round(performance.now() - t0), bx: +(br.x - sr.x).toFixed(1), by: +(br.y - sr.y).toFixed(1), cx: +(cr.x - br.x).toFixed(1), chx: +(ch.x - br.x).toFixed(1), n: c.textContent.trim() }); }
            if (performance.now() - t0 < 2000) requestAnimationFrame(f); else res(); }; requestAnimationFrame(f); });
          return out;`);
        if (!fr.length) return [...v, "s2's section never showed — proved nothing"];
        console.log(`        s2 read late: the section showed at ${fr[0].t} ms with ${J(fr[0].n)}; ${fr.length} frames`);
        if (fr[0].t < 700) v.push(`s2's section showed at ${fr[0].t} ms — the read wasn't late (proved nothing)`);
        const moved = fr.filter((x) => x.bx !== fr[0].bx || x.by !== fr[0].by || x.cx !== fr[0].cx || x.chx !== fr[0].chx || x.n !== fr[0].n);
        if (moved.length) v.push(`the header changed after it showed: ${J(fr[0])} → ${J(moved[0])}`);
        const c2 = await foldHead();
        console.log(`        s2: ${J(c2)}`);
        if (c2.count !== "· 2") v.push(`s2: the count reads ${J(c2.count)}, want "· 2" (a group heading, a label and a condition-hidden slider aren't counted)`);
        if (c2.shown !== 4 || c2.rows !== 2) v.push(`s2 shows ${c2.shown} entries / ${c2.rows} property rows, want 4 / 2 (the fixture didn't land)`);
        await shot("fold-count-s2");
      } finally { await post("/library/scene-props", { path: SC[0], reset: true }).catch(() => {}); await loadUi(); }
      return v;
    }));

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

    // "go to playing" selects the playing card and opens its sidebar (a click's selection, without the apply)
    await cell("lib:locateSelect", async () => {
      const v = [], J = JSON.stringify;
      await post("/apply", { path: K[0] }); await sleep(1500); await mv(5, 5, 100);
      const ctrl = (t) => `m.thumb("${t}").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }));`;
      const state = `return { side: m.sideTitle(), sel: [...document.querySelectorAll(".card.lib.selected")].map((c) => c.querySelector(".lib-title")?.dataset.title),
        focused: [...document.querySelectorAll(".card.lib.focused")].map((c) => c.querySelector(".lib-title")?.dataset.title),
        applied: window.__reqs.filter(([mm, p]) => mm === "POST" && (p.startsWith("/apply") || p.startsWith("/play"))).map(([, p]) => p) };`;
      const press = (btn, ms) => page(`window.__reqs = []; const b = document.querySelector('[data-go-playing="${btn}"]'); if (!b || b.disabled) return null; b.click(); await m.sleep(${ms}); ${state}`);
      // `card`: the grid shows the card (a search hiding it leaves no card to ring)
      const want = (label, r, side, card = true) => {
        console.log(`        ${label}: ${J(r)}`);
        if (!r) { v.push(`${label}: no enabled crosshair`); return; }
        if (r.side !== side) v.push(`${label}: the sidebar shows ${r.side}, not ${side}`);
        if (J(r.focused) !== J(card ? [side] : [])) v.push(`${label}: focused cards ${J(r.focused)}, want ${J(card ? [side] : [])}`);
        if (r.applied.length) v.push(`${label}: it applied (${J(r.applied)}) — the wallpaper is already playing`);
      };
      // the Library's, over a multi-selection with the sidebar on another card: the selection is replaced, like a plain click
      const pre = await page(`await m.closeAll(); ${ctrl("k2")} await m.sleep(150); ${ctrl("k3")} await m.sleep(200); await m.openSide("k3"); ${state}`);
      if (J(pre.sel) !== J(["k2", "k3"]) || pre.side !== "k3") return [`setup: selection ${J(pre.sel)}, sidebar ${pre.side} (want k2 + k3, k3)`];
      const lib = await press("library", 1800);
      want("library", lib, "k1");
      if (lib && lib.sel.length) v.push(`library: the selection ${J(lib.sel)} stayed — a click on the card replaces it`);
      // the bar's, with the sidebar on another card
      await page(`await m.closeAll(); await m.openSide("k2");`);
      want("bar", await press("bar", 1800), "k1");
      // a search hiding k1: the Library's crosshair finds nothing and leaves the sidebar alone; the bar's still opens k1
      const search = (q) => page(`const i = [...document.querySelectorAll(".tsearch input.search")].find((x) => x.checkVisibility()); if (!i) return false;
        m.setValue(i, ${J(q)}); await m.sleep(500); return true;`);
      await page(`await m.closeAll();`);
      if (!await search("k2")) v.push("no search field");
      else {
        const hid = await press("library", 600);
        console.log(`        library, k1 hidden: ${J(hid)}`);
        if (hid && (hid.side || hid.focused.length || hid.applied.length)) v.push(`library, k1 hidden by the search: it opened / applied something (${J(hid)})`);
        want("bar, k1 hidden", await press("bar", 1800), "k1", false);
        await page(`await m.closeAll();`); await search("");
      }
      // animations off: the sidebar on k1 at once
      await setMotion(false); await mv(5, 5, 100);
      await page(`await m.closeAll(); await m.openSide("k3");`);
      want("library, animations off", await press("library", 150), "k1");
      await setMotion(true);
      // to look at: the spotlight mid-glide with the sidebar opening, then the card ringed with its sidebar open
      await page(`await m.closeAll(); await m.openSide("k3"); document.querySelector('[data-go-playing="library"]').click(); await m.sleep(450);`);
      await shot("locate-select-mid"); await sleep(1800); await shot("locate-select-end");
      return v;
    });

    // ---- the sidebar's title (components/SideTitle.tsx): a long one unfolds and folds back, it and its words copy ----
    // k3 renamed to a title far past two lines (the stack's own index.json; put back after)
    const LONG = "An extremely long wallpaper title that keeps going well past the two lines the sidebar's head shows, so it has to unfold";
    const withLongTitle = async (fn) => {
      const INDEX = path.join(path.dirname(path.dirname(K[2])), "index.json"), idx0 = fs.readFileSync(INDEX, "utf8");
      const idx = JSON.parse(idx0), key = path.basename(path.dirname(K[2]));
      if (!idx[key]) throw new Error(`no index entry ${key} for k3`);
      idx[key] = { ...idx[key], title: LONG };
      fs.writeFileSync(INDEX + ".pb", JSON.stringify(idx)); fs.renameSync(INDEX + ".pb", INDEX);
      try {
        await loadUi();
        if (!await page(`return !!m.card(${JSON.stringify(LONG)});`)) throw new Error("the library shows no card with the long title — proved nothing");
        return await fn();
      } finally { fs.writeFileSync(INDEX + ".pb", idx0); fs.renameSync(INDEX + ".pb", INDEX); await mv(5, 5); await loadUi(); }
    };
    const titleState = () => page(`const s = m.side(), t = s?.querySelector("[data-side-title]"), h = t?.closest("h2"); if (!t) return null;
      const r = t.getBoundingClientRect(), hr = h.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, hx: hr.x, hy: hr.y, hh: +hr.height.toFixed(1), th: t.offsetHeight, state: t.dataset.sideTitle, role: t.getAttribute("role"),
        tab: t.getAttribute("tabindex"), exp: t.getAttribute("aria-expanded"), clamp: t.classList.contains("clamp"), title: h.getAttribute("title"),
        lh: parseFloat(getComputedStyle(t).lineHeight), text: t.textContent };`);
    // every frame for `ms`: the title's clip (the h2's box as drawn), its words' drawn height over their laid-out one (1 =
    // unstretched) and opacity, the scroller's top, the head's line's offset (its ::after transform), the motion-off ghost's
    // opacity, and the properties any running animation in the panel animates
    const TITLE_SAMPLE = (ms) => `(() => new Promise((res) => { const out = [], props = new Set(); const t0 = performance.now();
      const f = () => { const p = document.querySelector(".side-panel:not(.closing)"), t = p?.querySelector("[data-side-title]");
        if (t) { const h = t.closest("h2"), sc = p.querySelector(".side-scroll"), hd = p.querySelector(".side-head"), g = p.querySelector(".side-title-ghost");
          for (const a of p.getAnimations({ subtree: true })) for (const k of a.effect?.getKeyframes?.() ?? []) for (const q of Object.keys(k)) if (!["offset", "easing", "composite", "computedOffset"].includes(q)) props.add(q);
          let op = 1; for (let e = t; e && e.nodeType === 1; e = e.parentElement) op *= +getComputedStyle(e).opacity;
          const tf = getComputedStyle(hd, "::after").transform, line = tf === "none" ? 0 : new DOMMatrix(tf).m42;
          out.push({ t: Math.round(performance.now() - t0), hh: +h.getBoundingClientRect().height.toFixed(1), sr: +(t.getBoundingClientRect().height / t.offsetHeight).toFixed(3),
            op: +op.toFixed(3), sy: +sc.getBoundingClientRect().y.toFixed(1), line: +line.toFixed(1), g: g ? +getComputedStyle(g).opacity : null,
            gy: g ? +g.getBoundingClientRect().y.toFixed(1) : null, gb: g ? +(h.contains(g) ? Math.min(g.getBoundingClientRect().bottom, h.getBoundingClientRect().bottom) : g.getBoundingClientRect().bottom).toFixed(1) : null,
            ty: +t.getBoundingClientRect().y.toFixed(1) }); }
        if (performance.now() - t0 < ${ms}) requestAnimationFrame(f); else res({ out, props: [...props] }); };
      requestAnimationFrame(f); }))()`;
    function judgeTitle(dir, mode, f, props) {
      const v = [], on = mode === "on";
      if (f.length < 5) return [`${dir}: ${f.length} frames sampled — proved nothing`];
      const hs = f.map((x) => x.hh), d = hs[hs.length - 1] - hs[0];
      if (dir === "fold" ? d > -20 : d < 20) return [`${dir}: the title went ${hs[0]} → ${hs[hs.length - 1]} px — nothing ${dir}ed (proved nothing)`];
      const hb = between(hs), sys = f.map((x) => x.sy), sb = between(sys), lines = f.map((x) => x.line);
      console.log(`        ${dir} (${mode}): ${f.length} frames, box ${hs[0]} → ${hs[hs.length - 1]} (${hb} between), scroller ${sys[0]} → ${sys[sys.length - 1]} (${sb} between), `
        + `line offsets ${lines.filter((x) => Math.abs(x) > 1).length} frames, words ${MO.brief(f.map((x) => [x.t, x.op]))}, ghost ${MO.brief(f.map((x) => [x.t, x.g]))}`);
      if (Math.abs((sys[sys.length - 1] - sys[0]) - d) > 1.5) v.push(`${dir}: the scroller moved ${(sys[sys.length - 1] - sys[0]).toFixed(1)} px, the title ${d.toFixed(1)} px`);
      if (on) {
        if (hb < 3) v.push(`${dir}: the title's box jumped ${hs[0]} → ${hs[hs.length - 1]} (${hb} frames between) — it should morph`);
        if (sb < 3) v.push(`${dir}: the scroller jumped ${sys[0]} → ${sys[sys.length - 1]} (${sb} frames between) — it should glide with the title`);
        if (lines.filter((x) => Math.abs(x) > 1).length < 3) v.push(`${dir}: the head's line jumped (offsets ${JSON.stringify(lines.slice(0, 6))}) — it should glide`);
        const st = f.map((x) => x.sr).filter((x) => Math.abs(x - 1) > 0.02);
        if (st.length) v.push(`${dir}: the words stretched with the box in ${st.length} frames (drawn / laid-out height ${JSON.stringify(st.slice(0, 4))})`);
        if (f.some((x) => x.op < 0.99)) v.push(`${dir}: the words faded (opacity ${Math.min(...f.map((x) => x.op))}) — motion on, the box's clip reveals them`);
        const tys = f.map((x) => x.ty); if (spread(tys) > 0.75) v.push(`${dir}: the title's first line moved (y ${Math.min(...tys)}–${Math.max(...tys)})`);
      } else {
        if (hb > 0) v.push(`motion ${mode}, ${dir}: the title's box morphed (${hb} frames between) — it should change at once`);
        if (sb > 0) v.push(`motion ${mode}, ${dir}: the scroller glided (${sb} frames between) — it should move at once`);
        if (lines.some((x) => Math.abs(x) > 0.5)) v.push(`motion ${mode}, ${dir}: the head's line glided`);
        const ops = f.map((x) => x.op), gs = f.map((x) => x.g);
        // unfolding, the new title fades in (under the old one); folding, the old one starts whole over the new, so nothing
        // shows the swap until it fades
        if (dir === "unfold" && !ops.some((o) => o > 0.02 && o < 0.95)) v.push(`motion ${mode}, unfold: the new title popped in — no in-between opacity frame`);
        const g0 = gs.find((x) => x != null);
        if (dir === "fold" && !(g0 >= 0.95)) v.push(`motion ${mode}, fold: the old title didn't cover the swap (its first opacity ${g0})`);
        if (!gs.some((o) => o != null && o > 0.02 && o < 0.95)) v.push(`motion ${mode}, ${dir}: the old title popped out — no in-between ghost opacity (${JSON.stringify(gs.filter((x) => x != null).slice(0, 6))})`);
        if (gs[gs.length - 1] != null) v.push(`motion ${mode}, ${dir}: the old title's ghost is still there at the end`);
        const gys = f.map((x) => x.gy).filter((x) => x != null), tys = f.map((x) => x.ty);
        if (gys.length && (spread(gys) > 0.75 || Math.abs(gys[0] - tys[tys.length - 1]) > 0.75)) v.push(`motion ${mode}, ${dir}: the ghost isn't over the title, still (y ${JSON.stringify(gys.slice(0, 4))} vs ${tys[tys.length - 1]})`);
        if (spread(tys) > 0.75) v.push(`motion ${mode}, ${dir}: the title moved (y ${Math.min(...tys)}–${Math.max(...tys)})`);
        // the lines both titles show never dim: unfolding, the old one stays whole until the new one has faded in
        if (dir === "unfold") { const dim = f.filter((x) => x.op < 0.95 && !(x.g >= 0.95)); if (dim.length) v.push(`motion ${mode}, unfold: the shared lines dimmed in ${dim.length} frames (words ${dim[0].op}, ghost ${dim[0].g})`); }
        // folding, the hidden lines fade where they were, never over what sits below (it moves up once they're gone)
        else { const lap = f.filter((x) => x.g != null && x.g > 0.02 && x.gb > x.sy + 0.5); if (lap.length) v.push(`motion ${mode}, fold: the fading lines lay over the content in ${lap.length} frames (their bottom ${lap[0].gb}, the scroller's top ${lap[0].sy})`); }
      }
      const bad = props.filter((p) => (on ? /^(height|width|top|left|right|bottom|margin|padding|max-height|min-height)/.test(p) : p !== "opacity"));
      if (bad.length) v.push(`motion ${mode}, ${dir}: animates ${JSON.stringify(bad)}${on ? " (a layout property)" : " (only opacity may change)"}`);
      return v;
    }

    // side:titleFold:<on|off|reduced> — k3's long title, clamped to two lines, is a button (aria-expanded false, no tooltip);
    // a real click unfolds it to the whole title and another folds it back, sampled per frame: motion on, the title's box morphs
    // through in-between heights with its words unstretched and unfaded, the scroller and the head's line glide the same
    // distance; off / reduced, the box and the scroller change at once and the old title cross-fades into the new in place
    // (opacity only). Folded again: the clamp's ellipsis back, two lines tall. On: the open title under bg-live keeps its
    // drop-shadow wrapper. Screenshots side-title-<mode>-<unfold|fold>-mid.png, side-title-<mode>-open.png, side-title-bglive.png
    for (const mode of ["on", "off", "reduced"]) await cell(`side:titleFold:${mode}`, async () => withLongTitle(async () => {
      const v = [], J = JSON.stringify;
      try {
        if (mode === "off") await setMotion(false);
        if (mode === "reduced") await reducedMotion(true);
        await page(`await m.closeAll(); await m.openSide(${J(LONG)}); await m.sleep(400);`);
        const s0 = await titleState();
        console.log(`        folded: ${J({ ...s0, text: undefined })}`);
        if (!s0) return ["no sidebar title — proved nothing"];
        if (s0.state !== "folded" || s0.role !== "button" || s0.exp !== "false" || s0.tab !== "0") v.push(`the clamped title isn't a folded button (${J(s0)})`);
        if (!s0.clamp || Math.abs(s0.hh - 2 * s0.lh) > 1) v.push(`folded, the title is ${s0.hh} px (clamp ${s0.clamp}), want two lines (${2 * s0.lh})`);
        if (s0.title) v.push(`the title still has a tooltip (${J(s0.title)}): the click shows it whole`);
        if (s0.text !== LONG) v.push(`the title reads ${J(s0.text)}`);
        for (const dir of ["unfold", "fold"]) {
          const samp = js(TITLE_SAMPLE(900));
          await sleep(40); await clickAt(s0.x + 30, s0.y + 8);
          await sleep(mode === "on" ? 110 : 45); await shot(`title-${mode}-${dir}-mid`);
          const fr = await samp;
          await sleep(300);
          const st = await titleState();
          if (dir === "unfold") {
            await shot(`title-${mode}-open`);
            if (st.exp !== "true" || st.state !== "open" || st.clamp || Math.abs(st.hh - st.th) > 1 || st.th < 4 * st.lh) v.push(`after the unfold: ${J({ ...st, text: undefined })}`);
            if (mode === "on") {
              await mv(5, 5, 200);
              const live = await page(`const root = document.documentElement, had = root.classList.contains("bg-live"); root.classList.add("bg-live"); await m.sleep(80);
                const f = getComputedStyle(m.side().querySelector(".side-head-text")).filter; return { f, had };`);
              await shot("title-bglive");
              if (!live.had) await page(`document.documentElement.classList.remove("bg-live");`);
              if (!/drop-shadow/.test(live.f)) v.push(`bg-live: the open title lost its drop-shadow wrapper (${live.f})`);
            }
          } else if (st.exp !== "false" || st.state !== "folded" || !st.clamp || Math.abs(st.hh - 2 * st.lh) > 1) v.push(`after the fold: ${J({ ...st, text: undefined })}`);
          v.push(...judgeTitle(dir, mode, fr.out, fr.props));
        }
      } finally {
        if (mode === "off") await setMotion(true);
        if (mode === "reduced") await reducedMotion(false);
      }
      return v;
    }));

    // side:titlePlain — a title that fits in two lines (k2) is plain text: no button, no Tab stop, a click changes nothing
    await cell("side:titlePlain", async () => {
      const v = [], J = JSON.stringify;
      await page(`await m.closeAll(); await m.openSide("k2"); await m.sleep(400);`);
      const s0 = await titleState();
      if (s0.state !== "plain" || s0.role || s0.tab != null || s0.exp != null) v.push(`k2's title: ${J({ ...s0, text: undefined })}`);
      await clickAt(s0.x + 5, s0.y + 8); await sleep(600);
      const s1 = await titleState();
      if (s1.hh !== s0.hh || s1.state !== "plain") v.push(`a click on a plain title changed it (${s0.hh} → ${s1.hh}, ${s1.state})`);
      return v;
    });

    // side:titleFoldKeys — the folded title takes the focus; Enter unfolds it, Space folds it (real key events): nothing
    // applies, the sidebar stays on it; a switch to another item and back starts it folded
    await cell("side:titleFoldKeys", async () => withLongTitle(async () => {
      const v = [], J = JSON.stringify;
      await page(`await m.closeAll(); await m.openSide(${J(LONG)}); await m.sleep(400);`);
      const cur0 = await current();
      await page(`m.side().querySelector("[data-side-title]").focus();`);
      if (!await page(`return document.activeElement?.matches("[data-side-title]") ?? false;`)) return ["the title can't take the focus"];
      for (const [key, want] of [["Return", "true"], ["Space", "false"]]) {
        send({ type: "keyDown", keyCode: key }); if (key === "Return") send({ type: "char", keyCode: "\r" }); await sleep(30); send({ type: "keyUp", keyCode: key });
        await sleep(800);
        const st = await titleState();
        console.log(`        ${key}: aria-expanded ${st?.exp}, sidebar on ${(await page(`return m.sideTitle();`))?.slice(0, 20)}`);
        if (st?.exp !== want) v.push(`${key === "Return" ? "Enter" : "Space"} on the title: aria-expanded ${st?.exp}, want ${want}`);
      }
      if (await page(`return m.sideTitle();`) !== LONG) v.push("the keys moved or closed the sidebar");
      await sleep(300);
      if ((await current()) !== cur0) v.push(`a key applied a wallpaper (${T(cur0)} → ${T(await current())})`);
      // unfolded, a switch away and back: folded again
      await page(`m.side().querySelector("[data-side-title]").click(); await m.sleep(700); m.ctx(m.thumb("k2")); await m.sleep(700); m.ctx(m.thumb(${J(LONG)})); await m.sleep(800);`);
      const back = await titleState();
      if (back.exp !== "false" || !back.clamp) v.push(`back on the long title after a switch it's ${back.state} (clamp ${back.clamp})`);
      return v;
    }));

    // side:titleSelect — the title is selectable text, the way to copy it: no Copy button in the head, at rest or hovered; the
    // words are user-select text; a real drag across them selects them and doesn't unfold (it isn't a click); Ctrl+C then puts
    // the selection on the clipboard; a plain click still unfolds. Screenshot side-titleselect.png
    await cell("side:titleSelect", async () => withLongTitle(async () => {
      const v = [], J = JSON.stringify;
      const { clipboard } = require("electron");
      await mv(5, 5, 200);
      await page(`await m.closeAll(); await m.openSide(${J(LONG)}); await m.sleep(400);`);
      const s0 = await titleState();
      if (!s0) return ["no sidebar title"];
      const copies = () => page(`const h = m.side().querySelector(".side-head"); return h.querySelectorAll(".side-copy, [data-copy], .copy-btn").length;`);
      if (await copies()) v.push("the sidebar's head still has a Copy button");
      await mv(s0.x + 40, s0.y + 10, 350);
      if (await copies()) v.push("hovering the title shows a Copy button");
      const us = await page(`return getComputedStyle(m.side().querySelector("[data-side-title]")).userSelect;`);
      if (us !== "text" && us !== "auto") v.push(`the title's words aren't selectable (user-select ${us})`);
      // a drag across the words selects them; it isn't a click that unfolds
      await page(`getSelection().removeAllRanges(); document.activeElement?.blur();`);
      const y = s0.y + s0.lh / 2;
      send({ type: "mouseDown", x: Math.round(s0.x + 3), y: Math.round(y), button: "left", clickCount: 1 }); await sleep(40);
      for (let i = 1; i <= 6; i++) { send({ type: "mouseMove", x: Math.round(s0.x + 3 + i * 25), y: Math.round(y), button: "left" }); await sleep(20); }
      send({ type: "mouseUp", x: Math.round(s0.x + 153), y: Math.round(y), button: "left", clickCount: 1 }); await sleep(500);
      const sel = await page(`return getSelection().toString();`), s3 = await titleState();
      console.log(`        dragged: ${J(sel)}`);
      await shot("titleselect");
      if (sel.length < 4 || !LONG.startsWith(sel.trim().slice(0, 4))) v.push(`a drag across the title selected ${J(sel)}`);
      if (s3.exp !== "false") v.push("the drag that selected words unfolded the title");
      // Ctrl+C copies what's selected (the app's own Edit menu, hidden, keeps its accelerators)
      await clipboard.writeText("");
      send({ type: "keyDown", keyCode: "C", modifiers: ["control"] }); send({ type: "keyUp", keyCode: "C", modifiers: ["control"] }); await sleep(250);
      const got = await clipboard.readText();
      if (sel.length >= 4 && got !== sel) v.push(`Ctrl+C put ${J(got.slice(0, 60))} on the clipboard, want the selection ${J(sel.slice(0, 60))}`);
      await page(`getSelection().removeAllRanges();`);
      // a plain click still unfolds it
      await clickAt(s0.x + 30, s0.y + 8); await sleep(700);
      if ((await titleState()).exp !== "true") v.push("a plain click on the title didn't unfold it");
      await mv(5, 5, 100);
      return v;
    }));

    // ---- presets in the Library (LibraryCard reason, LibrarySide PresetNotice / BaseRow / PresetsRow, baseConfirm.ts,
    // BaseSceneConfirm.tsx, store unplayableReasonOf). The cells add their own items to the stack's library
    // and take them away again (the shared library the other cells count stays as it was): pb, a copy of s1 (its properties
    // color / clock / bars, bars shown while clock is on) under the Workshop id 910000003 (the CM fixture's scene whose two
    // presets Browse lists, "children"), and two presets of it in Wallpaper Engine's format, pp1 (color "0 0 1", clock false)
    // and pp2 (color "0 1 0"). Scene support on while they run.
    const PRE = { base: "910000003", p1: "910000011", p2: "910000012" };
    const WSDIR = path.dirname(SC[0]);
    const preDir = (id) => path.join(WSDIR, id);
    const withPresets = async (fn, settings = {}) => {
      const idx = path.join(WSDIR, "index.json"), idx0 = fs.readFileSync(idx, "utf8");
      const writeIdx = (s) => { fs.writeFileSync(idx + ".pb", s); fs.renameSync(idx + ".pb", idx); };
      const s0 = await getSettings(), keep = Object.fromEntries(Object.keys(settings).map((k) => [k, s0[k]]));
      try {
        fs.cpSync(SC[0], preDir(PRE.base), { recursive: true });
        const pj = JSON.parse(fs.readFileSync(path.join(SC[0], "project.json"), "utf8"));
        fs.writeFileSync(path.join(preDir(PRE.base), "project.json"), JSON.stringify({ ...pj, title: "pb" }));
        for (const [id, title, vals] of [[PRE.p1, "pp1", { color: "0 0 1", clock: false }], [PRE.p2, "pp2", { color: "0 1 0" }]]) {
          fs.mkdirSync(preDir(id), { recursive: true });
          fs.writeFileSync(path.join(preDir(id), "project.json"), JSON.stringify({ contentrating: "Everyone", dependency: PRE.base,
            preset: { _d0: null, alignment: 0, rate: 100, wec_e: false, ...vals }, preview: "preview.png", tags: ["Unspecified"], title, visibility: "public" }));
          fs.copyFileSync(path.join(SC[1], "preview.png"), path.join(preDir(id), "preview.png"));
        }
        const j = JSON.parse(idx0);
        j[PRE.base] = { title: "pb", isScene: true, workshopId: PRE.base };
        j[PRE.p1] = { title: "pp1", workshopId: PRE.p1, baseTitle: "pb" };
        j[PRE.p2] = { title: "pp2", workshopId: PRE.p2, baseTitle: "pb" };
        writeIdx(JSON.stringify(j));
        await setSettings({ allowScenes: true, ...settings });
        await loadUi();
        for (let i = 0; i < 50 && !(await page(`return !!m.card("pp2") && !!m.card("pb");`)); i++) await sleep(100);
        return await fn();
      } finally {
        // a base a cell trashed comes back through its Undo first: nothing of these stays in the library's trash
        for (let i = 0; i < 3 && !fs.existsSync(preDir(PRE.base)); i++) await post("/library/undo");
        for (const id of Object.values(PRE)) fs.rmSync(preDir(id), { recursive: true, force: true });
        writeIdx(idx0);
        await setSettings({ allowScenes: false, ...keep });
        await page(`localStorage.removeItem("liascape.libFilter");`).catch(() => {});
        await mv(5, 5); await loadUi();
      }
    };
    const reqsSince = (n) => js(`window.__reqs.slice(${n})`);
    const reqMark = () => js(`window.__reqs.length`);
    const statusText = () => page(`return document.querySelector(".status")?.textContent.trim() ?? "";`);
    // a card's preset state: greyed, its status icon (shown, its reason, its tooltip), the picture's filter
    const cardState = (t) => page(`const c = m.card(${JSON.stringify(t)}); if (!c) return null; const w = c.querySelector("[data-card-reason]"), th = c.querySelector(".thumb-wrap > .thumb");
      return { off: c.classList.contains("unplayable"), reason: w?.dataset.cardReason ?? null, title: w?.getAttribute("title") ?? null, op: w ? +getComputedStyle(w).opacity : null,
        filter: th ? getComputedStyle(th).filter : null };`);
    const alpha = (c) => +(/\/\s*([\d.]+)\s*\)/.exec(c)?.[1] ?? /rgba\([^)]*,\s*([\d.]+)\)/.exec(c)?.[1] ?? "1");
    const visibleGlow2 = (bs) => !!bs && bs !== "none" && !/^(rgba\(0, 0, 0, 0\)[^,]*)(, rgba\(0, 0, 0, 0\)[^,]*)*$/.test(bs);
    // an element's opacity per frame passes through in-between values (a fade, not a jump)
    const fades = (fr) => fr.filter((f) => f[1] != null && f[1] > 0.05 && f[1] < 0.95).length;

    // lib:preset:props — a preset's sidebar lists its base's properties with the preset's values as their defaults (pp1:
    // color blue, clock off, so bars hides; pb, the base, shows its own: red, clock on, bars), nothing marked changed; a
    // tweak (clock on) marks it and shows bars, saved to pp1 alone (pb's properties untouched); its Default returns to the
    // preset's value.
    await cell("lib:preset:props", async () => withPresets(async () => {
      const v = [], J = JSON.stringify;
      const rows = (t) => page(`await m.closeAll(); await m.openSide(${J(t)});
        for (let i = 0; i < 60 && !m.side()?.querySelector('[data-scene-prop="clock"]'); i++) await m.sleep(50); await m.sleep(300);
        const s = m.side(), q = (n) => s.querySelector('[data-scene-prop="' + n + '"]');
        return { color: q("color")?.querySelector("input[type=color]")?.value ?? null, clock: q("clock")?.querySelector("input[type=checkbox]")?.checked ?? null,
          bars: !!q("bars"), defaults: [...s.querySelectorAll("[data-scene-prop] .mini")].map((b) => b.closest("[data-scene-prop]").dataset.sceneProp) };`);
      const base = await rows("pb"), pre = await rows("pp1");
      console.log(`        pb ${J(base)} / pp1 ${J(pre)}`);
      if (base.clock == null || pre.clock == null) return [`no clock row (pb ${J(base)}, pp1 ${J(pre)}) — proved nothing`];
      if (base.color !== "#ff0000" || base.clock !== true || !base.bars) v.push(`pb shows ${J(base)}, want its own red / clock on / bars`);
      if (pre.color !== "#0000ff" || pre.clock !== false || pre.bars) v.push(`pp1 shows ${J(pre)}, want the preset's blue / clock off / no bars`);
      if (pre.defaults.length) v.push(`pp1 marks ${J(pre.defaults)} changed before any tweak (the preset's values are its defaults)`);
      const ck = await page(`const c = m.side().querySelector('[data-scene-prop="clock"] input[type=checkbox]'); c.scrollIntoView({ block: "nearest" }); await m.sleep(200); return m.rect(c);`);
      await clickAt(ck.x + ck.w / 2, ck.y + ck.h / 2); await sleep(700);
      const t1 = await page(`const s = m.side(), r = s.querySelector('[data-scene-prop="clock"]');
        return { clock: r.querySelector("input[type=checkbox]").checked, def: !!r.querySelector(".mini"), tip: r.querySelector(".mini")?.title ?? null, bars: !!s.querySelector('[data-scene-prop="bars"]') };`);
      const pp = (await http("GET", `/library/scene-props?path=${encodeURIComponent(preDir(PRE.p1))}`)).json?.props?.find((x) => x.name === "clock");
      const bp = (await http("GET", `/library/scene-props?path=${encodeURIComponent(preDir(PRE.base))}`)).json?.props?.find((x) => x.name === "clock");
      console.log(`        tweaked: ${J(t1)}; pp1 clock ${J(pp && { value: pp.value, overridden: pp.overridden })}, pb clock ${J(bp && { value: bp.value, overridden: bp.overridden })}`);
      if (!t1.clock || !t1.def || !t1.bars) v.push(`after the tweak pp1 shows ${J(t1)}, want clock on, marked (Default), bars shown`);
      if (t1.tip !== "Back to the preset's value") v.push(`the Default button's tooltip says ${J(t1.tip)}`);
      if (!pp || pp.value !== true || !pp.overridden) v.push(`pp1's clock reads ${J(pp)}, want true + overridden`);
      if (!bp || bp.value !== true || bp.overridden) v.push(`the tweak reached pb: ${J(bp)}`);
      await page(`m.side().querySelector('[data-scene-prop="clock"] .mini').click();`); await sleep(700);
      const t2 = await page(`const r = m.side().querySelector('[data-scene-prop="clock"]'); return { clock: r.querySelector("input[type=checkbox]").checked, def: !!r.querySelector(".mini") };`);
      if (t2.clock !== false || t2.def) v.push(`Default left pp1's clock at ${J(t2)}, want the preset's off, unmarked`);
      await shot("preset-props");
      return v;
    }));

    // lib:preset:uses — a preset's sidebar says which scene it plays ("Uses" + the base's title, the creator row's control:
    // WsListRow) from its own file, never asking Steam (/workshop/base); a click puts the sidebar on the base's own card,
    // focused. A scene's sidebar has no such row.
    await cell("lib:preset:uses", async () => withPresets(async () => {
      const v = [], J = JSON.stringify;
      const n0 = await reqMark();
      await page(`await m.closeAll(); await m.openSide("pp1"); await m.sleep(600);`);
      const row = await page(`const b = m.side().querySelector("[data-ws-base]"); if (!b) return null;
        return { name: b.querySelector("[data-ws-row-name]")?.textContent.trim(), label: b.getAttribute("aria-label"), ctl: b.classList.contains("ws-creator"), state: b.dataset.wsBase, r: m.rect(b) };`);
      console.log(`        ${J(row)}`);
      if (!row) return ["pp1's sidebar has no Uses row"];
      if (row.name !== "pb") v.push(`the Uses row names ${J(row.name)}, want pb`);
      if (!row.ctl) v.push("the Uses row isn't the shared row control (.ws-creator)");
      if (!/^Uses pb\. Show it in your library$/.test(row.label ?? "")) v.push(`its label says ${J(row.label)}`);
      await shot("preset-uses");
      await clickAt(row.r.x + row.r.w / 2, row.r.y + row.r.h / 2); await sleep(700);
      const after = await page(`return { title: m.sideTitle(), focused: !!m.card("pb")?.classList.contains("focused") };`);
      if (after.title !== "pb" || !after.focused) v.push(`after the click: sidebar ${J(after.title)}, pb focused ${after.focused}`);
      const asked = (await reqsSince(n0)).filter(([, p]) => p === "/workshop/base");
      if (asked.length) v.push(`asked Steam for the base (${asked.length} × /workshop/base): the preset's own file names it`);
      if (await page(`return !!m.side()?.querySelector("[data-ws-base]");`)) v.push("the base scene's own sidebar shows a Uses row");
      return v;
    }));

    // lib:presets:scene — a Library scene with a Workshop id shows Browse's "Presets" row (PresetsRow); a click lists its
    // presets on the Browse tab (the CM fixture's two that name 910000003), the ones the library has marked so; a preset's
    // sidebar has no Presets row. The Library's filter: Preset ticked keeps exactly the two presets (facetsOf `preset`).
    await cell("lib:presets:scene", async () => withPresets(async () => {
      const v = [], J = JSON.stringify;
      // the presets list moves Browse to the Workshop: the source the other cells start on comes back after
      const src0 = await page(`return localStorage.getItem("liascape.activeSource");`);
      try {
      await page(`await m.closeAll(); await m.openSide("pp1"); await m.sleep(500);`);
      if (await page(`return !!m.side().querySelector("[data-ws-presets]");`)) v.push("a preset's sidebar shows a Presets row");
      await page(`await m.closeAll(); await m.openSide("pb"); await m.sleep(500);`);
      const row = await page(`const b = m.side().querySelector("[data-ws-presets]"); return b ? { id: b.dataset.wsPresets, ctl: b.classList.contains("ws-creator"), r: m.rect(b) } : null;`);
      if (!row) return [...v, "pb's sidebar has no Presets row"];
      if (row.id !== PRE.base || !row.ctl) v.push(`the Presets row ${J(row)}`);
      await clickAt(row.r.x + row.r.w / 2, row.r.y + row.r.h / 2);
      let got = null;
      for (let i = 0; i < 60; i++) {
        got = await page(`const tab = document.querySelector(".tab.active")?.textContent.trim();
          const cards = [...document.querySelectorAll(".card")].filter((c) => !c.closest(".lib-scroll")).map((c) => ({ t: c.querySelector("[data-title]")?.dataset.title, lib: !!c.querySelector("[data-in-library]") }));
          return { tab, cards };`);
        if (got.tab === "Browse" && got.cards.length >= 2) break;
        await sleep(150);
      }
      console.log(`        ${J(got)}`);
      const titles = got.cards.map((c) => c.t).sort();
      if (got.tab !== "Browse") v.push(`the click left the ${J(got.tab)} tab showing, want Browse`);
      if (J(titles) !== J(["Fixture Preset One", "Fixture Preset Two"])) v.push(`Browse lists ${J(titles)}, want the scene's two presets`);
      else if (!got.cards.every((c) => c.lib)) v.push(`the presets the library has aren't marked In library (${J(got.cards)})`);
      await shot("presets-scene-browse");
      await tab("Library");
      // the Library's Preset filter (its saved include, read at load)
      await page(`localStorage.setItem("liascape.libFilter", JSON.stringify({ sort: "trend", trendDays: 7, include: ["Preset"], exclude: [], featureMatch: "all", genreMatch: "any" }));`);
      await loadUi(); await sleep(400);
      const shown = (await page(`return [...document.querySelectorAll(".lib-scroll .card.lib")].map((c) => c.querySelector(".lib-title")?.dataset.title);`)).sort();
      if (J(shown) !== J(["pp1", "pp2"])) v.push(`the Library filtered to Preset shows ${J(shown)}, want pp1 and pp2`);
      } finally {
        await page(src0 == null ? `localStorage.removeItem("liascape.activeSource");` : `localStorage.setItem("liascape.activeSource", ${JSON.stringify(src0)});`).catch(() => {});
      }
      return v;
    }));

    // lib:preset:badge — side by side in the Library, a preset's card (pp1) says PRESET and its base (pb) and a plain scene
    // (s1) SCENE: one `.badge` in the same corner and type (TypeBadge.tsx), the preset's look apart from the scenes' in at
    // least two of fill, letters, ring and glyph, under two themes with glow on and off
    await cell("lib:preset:badge", async () => {
      const v = [], J = JSON.stringify, APART = ["bg", "fg", "ring", "svg"]; // what a glance tells a tag by
      const s0 = await getSettings(), themes = (await http("GET", "/themes")).json ?? [];
      const t0 = s0.theme ?? themes[0]?.name, t1 = themes.find((t) => t.name !== t0)?.name, light = themes.find((t) => /latte/i.test(t.name) && t.name !== t0)?.name; // a light theme too: the hollow badge on a light fill
      if (!t0 || !t1) return [`themes ${J(themes.map((t) => t.name))} — two needed, proved nothing`];
      const read = () => page(`return ["pp1", "pb", "s1"].map((t) => { const c = m.card(t), b = c?.querySelector(".thumb-wrap > .badge"); if (!b) return { t, text: null };
        const s = getComputedStyle(b), w = c.querySelector(".thumb-wrap").getBoundingClientRect(), r = b.getBoundingClientRect();
        return { t, text: b.textContent.trim(), cls: b.className, dx: Math.round(r.left - w.left), dy: Math.round(r.top - w.top), h: Math.round(r.height),
          look: [s.backgroundColor, s.color, s.boxShadow, s.fontSize, s.fontWeight, s.letterSpacing, s.padding, s.borderRadius].join(" | "),
          bg: s.backgroundColor, fg: s.color, ring: /inset/.test(s.boxShadow), svg: !!b.querySelector("svg"), type: [s.fontSize, s.fontWeight, s.letterSpacing, s.borderRadius].join(" ") }; });`);
      try {
        for (const theme of [t0, t1, light].filter(Boolean)) for (const glows of [true, false]) await withPresets(async () => {
          const tag = `${theme}${glows ? "" : " no-glow"}`;
          if (!(await page(`return !!m.card("pp1") && !!m.card("pb") && !!m.card("s1");`))) { v.push(`${tag}: pp1 / pb / s1 not all in the Library — proved nothing`); return; }
          const [pre, base, plain] = await read();
          console.log(`        ${tag}: ${J([pre.text, base.text, plain.text])}`);
          if (pre.text !== "PRESET") v.push(`${tag}: pp1 (a preset) says ${J(pre.text)}, want PRESET`);
          if (base.text !== "SCENE") v.push(`${tag}: pb (its base) says ${J(base.text)}, want SCENE`);
          if (plain.text !== "SCENE") v.push(`${tag}: s1 (a plain scene) says ${J(plain.text)}, want SCENE`);
          if (base.text) for (const k of ["cls", "dx", "dy", "h", "look"]) if (base[k] !== plain[k]) v.push(`${tag}: pb's badge ${k} ${J(base[k])} ≠ s1's ${J(plain[k])}`);
          if (pre.text) {
            for (const k of ["dx", "dy", "type"]) if (pre[k] !== plain[k]) v.push(`${tag}: pp1's badge ${k} ${J(pre[k])} ≠ s1's ${J(plain[k])}`);
            const d = APART.filter((k) => pre[k] !== plain[k]);
            if (d.length < 2) v.push(`${tag}: pp1's badge differs from a scene's only in ${J(d)} — want two of ${J(APART)} (${pre.look} vs ${plain.look})`);
          }
          const sh = plain.look?.split(" | ")[2] ?? "none", lit = sh !== "none" && !/^rgba\(0, 0, 0, 0\)/.test(sh); // no-glow: a transparent shadow
          if (lit !== glows) v.push(`${tag}: the badge ${lit ? "glows" : "doesn't glow"} (${plain.look})`);
          // the sidebar's hero chip says the same as the card (LibrarySide.tsx)
          const chips = [];
          for (const t of ["pp1", "pb", "s1"]) chips.push(await page(`await m.closeAll(); await m.openSide(${J(t)});
            const c = m.side().querySelector(".side-hero > .side-chip.accent:not([data-side-looping])"); if (!c) return { t: ${J(t)}, text: null };
            const s = getComputedStyle(c); return { t: ${J(t)}, text: c.textContent.trim(), cls: c.className, look: [s.backgroundColor, s.color, s.boxShadow, s.fontSize, s.padding].join(" | "),
              bg: s.backgroundColor, fg: s.color, ring: s.boxShadow, svg: !!c.querySelector("svg"), type: s.fontSize };`));
          await page(`await m.closeAll();`);
          console.log(`        ${tag} sidebar: ${J(chips.map((c) => c.text))}`);
          const want = { pp1: "PRESET", pb: "SCENE", s1: "SCENE" };
          for (const c of chips) if (c.text !== want[c.t]) v.push(`${tag}: ${c.t}'s sidebar chip says ${J(c.text)}, want ${want[c.t]}`);
          const [cp, cb, cs] = chips;
          if (cb.text) for (const k of ["cls", "look"]) if (cb[k] !== cs[k]) v.push(`${tag}: pb's sidebar chip ${k} ${J(cb[k])} ≠ s1's ${J(cs[k])}`);
          if (cp.text) {
            if (cp.type !== cs.type) v.push(`${tag}: pp1's sidebar chip size ${J(cp.type)} ≠ s1's ${J(cs.type)}`);
            const d = APART.filter((k) => cp[k] !== cs[k]);
            if (d.length < 2) v.push(`${tag}: pp1's sidebar chip differs from a scene's only in ${J(d)} — want two of ${J(APART)} (${cp.look} vs ${cs.look})`);
          }
          // pp1's sidebar open beside its card and pb's, one shot per theme and glow
          await page(`await m.openSide("pp1"); await m.sleep(400);`);
          await shot(`preset-badge-${theme.replace(/\W+/g, "-").toLowerCase()}${glows ? "" : "-noglow"}`);
          if (theme === t1 && glows) await shot("preset-badge");
          await page(`await m.closeAll();`);
        }, { theme, glows });
        // bg-live: the docked sidebar has no fill of its own, so the hollow chip's own dark fill must carry it
        await withPresets(async () => {
          const c = await page(`await m.closeAll(); await m.openSide("pp1"); document.documentElement.classList.add("bg-live"); await m.sleep(400);
            const c = m.side().querySelector(".side-hero > .side-chip.accent.preset"); if (!c) return null;
            const s = getComputedStyle(c); return { bg: s.backgroundColor, svg: !!c.querySelector("svg"), live: document.documentElement.classList.contains("bg-live") };`);
          console.log(`        bg-live sidebar: ${J(c)}`);
          if (!c?.live) v.push(`bg-live: :root.bg-live not set — proved nothing`);
          else if (!c.svg || /^rgba\(0, 0, 0, 0\)$|^transparent$/.test(c.bg)) v.push(`bg-live: pp1's chip ${J(c)} — want its glyph and a fill of its own`);
          await shot("preset-badge-bglive");
          await page(`document.documentElement.classList.remove("bg-live"); await m.closeAll();`);
        });
      } finally { await setSettings({ theme: t0, glows: s0.glows ?? true }); }
      return v;
    });

    // lib:preset:needsBase:<on|off> — the base goes while pp1's sidebar is open (trashed by the backend, the page told
    // through library-synced): pp1 and pp2 grey out (the picture greyscale, a status icon in --warn fading in, its tooltip the
    // reason) and pp1's sidebar gets the crash notice's block, in --warn, rising in (off: fading in place): "Needs its base
    // scene, pb" + "Download it again". A click on the greyed card plays nothing and the status bar says why. The button
    // follows the preset and the mode: pp2 (subscribed) a plain download, pp1 (the library's own copy) a one-off while
    // /workshop/one-off has a route, else plain; a mode that can't download now (signed out under "subscribe", a WS
    // settings-changed the page alone sees) shows it disabled with the reason, a click sends nothing. A click (one-off) →
    // POST /download of the base's Workshop id (held), the button says it's downloading; the base back (Undo) and the
    // download answered → the notice leaves (fade; off: opacity only) and the cards come back. Hovered, the button glows (none
    // under no-glow); under bg-live the notice keeps its fill. Shots side-needsbase-*.png
    for (const mode of ["on", "off"]) await cell(`lib:preset:needsBase${mode === "off" ? "Off" : ""}`, async () => withPresets(async () => {
      const v = [], J = JSON.stringify, S = (sel) => `.side-panel:not(.closing) ${sel}`;
      // pp1's own status icon: every scene card carries one too (hidden while it plays)
      const PP1_ICON = `.card.lib:has([data-title="pp1"]) [data-card-reason]`;
      const cur0 = await current();
      try {
        if (mode === "off") { await setMotion(false); }
        const ws = ((await http("GET", "/sources")).json || []).find((x) => x.supportsTagFilter && x.available)?.index;
        await page(`window.__oneOff = { route: "steamapp", missing: null }; window.__libPatch = { ${J(preDir(PRE.p2))}: { subscribed: true }, ${J(preDir(PRE.p1))}: { subscribed: false } };
          await m.closeAll(); await m.openSide("pp1"); await m.sleep(600);`);
        const before = await cardState("pp1");
        if (await page(`return !!m.side().querySelector("[data-preset-note]");`) || before?.off) return [`pp1 can't play before its base went (${J(before)}) — proved nothing`];
        // the base goes: trashed in the backend, the page re-reads the library (library-synced)
        const baseItem = await libItem(preDir(PRE.base));
        const samp = js(MO.SAMPLE({ note: S("[data-preset-note]"), icon: PP1_ICON }, 1400));
        await sleep(40);
        const tr = await post("/library/trash", { items: [baseItem] });
        if (tr.status !== 200) return [`trashing pb answered ${tr.status}`];
        await js(`window.__fakeWs("library-synced", {})`);
        const fr = await samp;
        console.log(`        motion ${mode}: note ${MO.brief(fr.note)} / icon ${MO.brief(fr.icon)}`);
        v.push(...MO.judge("the needs-base notice", fr.note, { appear: true, still: mode === "off", maxMs: mode === "on" ? 450 : 300 }));
        if (fades(fr.icon) < 1) v.push(`the card's status icon didn't fade in (${MO.brief(fr.icon)})`);
        await sleep(300);
        for (const t of ["pp1", "pp2"]) {
          const c = await cardState(t);
          console.log(`        ${t}: ${J(c)}`);
          if (!c?.off || c.reason !== "Needs its base scene" || c.title !== "Needs its base scene" || c.op < 0.99) v.push(`${t}'s card isn't greyed with its reason: ${J(c)}`);
          if (!/grayscale\(1\)/.test(c?.filter ?? "")) v.push(`${t}'s picture isn't grey (${c?.filter})`);
        }
        if (await page(`return !!m.card("pb");`)) v.push("pb's card still shows after it was trashed");
        const note = await page(`const s = m.side(), n = s.querySelector("[data-preset-note]"); if (!n) return null; const b = n.querySelector("[data-preset-get]");
          const d = document.createElement("div"); d.style.color = "var(--warn)"; document.body.appendChild(d); const warn = getComputedStyle(d).color; d.remove();
          const tx = getComputedStyle(n.querySelector(".side-crash-text")).color;
          return { text: n.querySelector(".side-crash-text")?.textContent.trim(), crashBlock: n.classList.contains("side-crash"), btn: b?.textContent.trim() ?? null, kind: b?.dataset.presetGet ?? null,
            off: b?.getAttribute("aria-disabled") ?? null, ico: getComputedStyle(n.querySelector(".side-crash-ico")).color, warn, tx, r: b ? m.rect(b) : null };`);
        console.log(`        notice ${J(note)}`);
        if (!note) return [...v, "pp1's sidebar has no needs-base notice"];
        if (note.text !== "Needs its base scene, pb") v.push(`the notice says ${J(note.text)}`);
        if (!note.crashBlock) v.push("the notice isn't the crash notice's block");
        if (note.ico !== note.warn || note.ico === note.tx) v.push(`its glyph is ${note.ico}, want --warn ${note.warn} (not the text's ${note.tx})`);
        if (note.btn !== "Download it again" || note.kind !== "one-off" || note.off) v.push(`pp1's button: ${J(note)}, want "Download it again", a one-off, enabled`);
        if (mode === "on") await shot("needsbase-side");
        // a click on the greyed card: nothing plays, the status bar says why
        await page(`await m.closeAll();`);
        const th = await page(`const t = m.thumb("pp1"); t.scrollIntoView({ block: "center" }); await m.sleep(300); return m.rect(t);`);
        const n1 = await reqMark();
        await clickAt(th.x + th.w / 2, th.y + th.h / 2); await sleep(500);
        const applied = (await reqsSince(n1)).filter(([mt, p]) => mt === "POST" && p === "/apply");
        const st = await statusText();
        console.log(`        click on pp1: ${applied.length} /apply, status ${J(st)}`);
        if (applied.length) v.push(`a click on greyed pp1 posted /apply ${applied.length}×`);
        if (st !== "Can't play pp1: it needs its base scene") v.push(`the status bar says ${J(st)}`);
        if ((await current()) !== cur0) v.push(`the playing wallpaper changed (${T(await current())})`);
        if (mode === "on") await shot("needsbase-cards");
        // pp2, a subscribed preset: a plain download; pp1 with no one-off route: a plain download too
        await page(`await m.openSide("pp2"); await m.sleep(500);`);
        const k2 = await page(`return m.side().querySelector("[data-preset-get]")?.dataset.presetGet ?? null;`);
        if (k2 !== "download") v.push(`pp2 (subscribed): the button is ${J(k2)}, want a plain download`);
        // the mode can't download now (signed out under "subscribe"): disabled, the reason under the words, a click sends nothing
        await js(`window.__fakeWs("settings-changed", { workshopDownloadMode: "subscribe" })`); await sleep(400);
        const blk = await page(`const n = m.side().querySelector("[data-preset-note]"), b = n?.querySelector("[data-preset-get]");
          return { off: b?.getAttribute("aria-disabled") ?? null, why: n?.querySelector("[data-preset-why]")?.textContent.trim() ?? null };`);
        const n2 = await js(`window.__dl.length + window.__reqs.filter(([m, p]) => p === "/download").length`);
        await page(`window.__dlHold = true; m.side().querySelector("[data-preset-get]").click(); await m.sleep(300);`);
        const n3 = await js(`window.__dl.length + window.__reqs.filter(([m, p]) => p === "/download").length`);
        console.log(`        blocked: ${J(blk)}`);
        if (blk.off !== "true" || !/^Sign in to Steam/.test(blk.why ?? "")) v.push(`signed out under "subscribe": ${J(blk)}, want disabled with the reason`);
        if (n3 !== n2) v.push("the disabled button sent a download");
        if (mode === "on") await shot("needsbase-blocked");
        await js(`window.__fakeWs("settings-changed", { workshopDownloadMode: "steamapp" })`); await sleep(300);
        await page(`window.__oneOff = { route: null, missing: "Steam isn't running" }; await m.closeAll(); await m.openSide("pp1"); await m.sleep(600);`);
        const k1 = await page(`return m.side().querySelector("[data-preset-get]")?.dataset.presetGet ?? null;`);
        if (k1 !== "download") v.push(`pp1 with no one-off route: the button is ${J(k1)}, want a plain download`);
        await page(`window.__oneOff = { route: "steamapp", missing: null }; await m.closeAll(); await m.openSide("pp1"); await m.sleep(600);`);
        // hovered: it glows, none under no-glow; bg-live: the notice keeps its fill
        const br = await page(`const b = m.side().querySelector("[data-preset-get]"); return m.rect(b);`);
        await mv(br.x + br.w / 2, br.y + br.h / 2, 400);
        const look = await page(`const b = m.side().querySelector("[data-preset-get]"), root = document.documentElement, out = { glow: getComputedStyle(b).boxShadow };
          root.classList.add("no-glow"); await m.sleep(250); out.noGlow = getComputedStyle(b).boxShadow; out.icoNoGlow = getComputedStyle(m.side().querySelector("[data-preset-note] .side-crash-ico > svg")).filter;
          root.classList.remove("no-glow"); const had = root.classList.contains("bg-live"); root.classList.add("bg-live"); await m.sleep(60);
          out.liveBg = getComputedStyle(m.side().querySelector("[data-preset-note]")).backgroundColor; if (!had) root.classList.remove("bg-live"); return out;`);
        if (!visibleGlow2(look.glow)) v.push(`the hovered button doesn't glow (${look.glow})`);
        if (visibleGlow2(look.noGlow) || look.icoNoGlow !== "none") v.push(`no-glow: still glowing (${look.noGlow}, glyph ${look.icoNoGlow})`);
        if (alpha(look.liveBg) < 0.3) v.push(`bg-live: the notice has no fill of its own (${look.liveBg})`);
        if (mode === "on") {
          await page(`document.documentElement.classList.add("no-glow");`); await sleep(250); await shot("needsbase-noglow");
          await page(`document.documentElement.classList.remove("no-glow"); document.documentElement.classList.add("bg-live");`); await sleep(250);
          await shot("needsbase-bglive"); await page(`document.documentElement.classList.remove("bg-live");`);
        }
        // the download: the base's Workshop id through the mode, a one-off (pp1 is the library's own copy), held
        await clickAt(br.x + br.w / 2, br.y + br.h / 2); await sleep(400);
        const dl = await js(`window.__dl.slice()`);
        const busy = await page(`const b = m.side().querySelector("[data-preset-get]"); return { text: b?.textContent.trim(), off: b?.getAttribute("aria-disabled") };`);
        console.log(`        download ${J(dl.map((d) => ({ source: d.source, id: d.result?.workshopId, oneOff: d.oneOff, apply: d.apply })))}; button ${J(busy)}`);
        if (dl.length !== 1) v.push(`${dl.length} downloads sent, want 1`);
        else if (dl[0].result?.workshopId !== PRE.base || dl[0].oneOff !== true || dl[0].apply !== false || dl[0].source !== ws)
          v.push(`the download sent ${J({ source: dl[0].source, id: dl[0].result?.workshopId, oneOff: dl[0].oneOff, apply: dl[0].apply })}, want the Workshop (${ws}) ${PRE.base} one-off, not applied`);
        if (busy.text !== "Downloading…" || busy.off !== "true") v.push(`while it downloads the button reads ${J(busy)}`);
        // the base lands: the notice leaves, the cards come back
        await mv(5, 5);
        const out = js(MO.SAMPLE({ note: S("[data-preset-note]"), icon: PP1_ICON }, 1400));
        await sleep(40);
        await post("/library/undo");
        await js(`window.__dlGo?.()`);
        const fo = await out;
        console.log(`        landed, motion ${mode}: note ${MO.brief(fo.note)} / icon ${MO.brief(fo.icon)}`);
        v.push(...MO.judge("the needs-base notice", fo.note, { leave: true, still: mode === "off", maxMs: mode === "on" ? 450 : 300 }));
        if (fades(fo.icon) < 1) v.push(`the card's status icon didn't fade out (${MO.brief(fo.icon)})`);
        if (mode === "on") await shot("needsbase-landed");
        for (const t of ["pp1", "pp2"]) { const c = await cardState(t); if (c?.off || c?.op > 0.01) v.push(`${t} still greyed after the base came back: ${J(c)}`); }
      } finally {
        await page(`window.__dlHold = false; window.__dlGo?.(); window.__oneOff = null; window.__libPatch = null;`).catch(() => {});
        if (mode === "off") await setMotion(true);
      }
      return v;
    }, { workshopDownloadMode: "steamapp" }));

    // lib:scenesBlocked — the scene renderer is missing (a WS scenes-blocked only the page sees; the backend's latch, read
    // at load from /current): every scene (pb, s2) and preset (pp1) greys with the reason through the preset's own path
    // (the same status icon, its tooltip the reason), a video doesn't; a click plays nothing and the status bar says why;
    // the sidebar's notice has the reason. Cleared → all playable again.
    await cell("lib:scenesBlocked", async () => withPresets(async () => {
      const v = [], J = JSON.stringify, WHY = "The scene renderer is missing — rebuild or reinstall Liascape";
      const video = await page(`const c = [...document.querySelectorAll(".card.lib")].find((c) => !c.querySelector(".badge") && !c.querySelector("[data-card-reason]"));
        return c?.querySelector("[data-title]")?.dataset.title ?? null;`);
      if (!video) return ["no video card in the library — proved nothing"];
      const vidOff = () => page(`return m.card(${J(video)})?.classList.contains("unplayable") ?? null;`);
      const c0 = { pb: await cardState("pb"), pp1: await cardState("pp1") };
      if (c0.pb?.off || c0.pp1?.off) return [`greyed before the latch (${J(c0)}) — proved nothing`];
      await js(`window.__fakeWs("scenes-blocked", { reason: ${J(WHY)} })`); await sleep(800);
      const st = { pb: await cardState("pb"), s2: await cardState("s2"), pp1: await cardState("pp1") };
      console.log(`        blocked: ${J(st)}`);
      for (const t of ["pb", "s2", "pp1"]) if (!st[t]?.off || st[t].reason !== WHY || st[t].title !== WHY || !(st[t].op > 0.5)) v.push(`${t} blocked: ${J(st[t])}`);
      if (await vidOff()) v.push(`the video ${video} greyed too`);
      await shot("scenes-blocked");
      const th = await page(`const t = m.thumb("pb"); t.scrollIntoView({ block: "center" }); await m.sleep(300); return m.rect(t);`);
      const n0 = await reqMark();
      await clickAt(th.x + th.w / 2, th.y + th.h / 2); await sleep(500);
      if ((await reqsSince(n0)).some(([mt, p]) => mt === "POST" && p === "/apply")) v.push("a click on pb posted /apply");
      const sb = await statusText();
      if (sb !== "Can't play pb: the scene renderer is missing — rebuild or reinstall Liascape") v.push(`the status bar says ${J(sb)}`);
      await page(`await m.openSide("pb"); await m.sleep(500);`);
      const note = await page(`const n = m.side().querySelector("[data-preset-note]"); return n ? n.querySelector(".side-crash-text").textContent.trim() : null;`);
      if (note !== WHY) v.push(`pb's notice: ${J(note)}`);
      await page(`await m.closeAll();`);
      await js(`window.__fakeWs("scenes-blocked", { reason: null })`); await sleep(800);
      const back = { pb: await cardState("pb"), s2: await cardState("s2"), pp1: await cardState("pp1") };
      console.log(`        back: ${J(back)}`);
      for (const t of ["pb", "s2", "pp1"]) if (back[t]?.off || back[t]?.op > 0.01) v.push(`${t} still greyed once cleared: ${J(back[t])}`);
      return v;
    }));

    // lib:incomplete:<on|off> — pb (a Workshop scene) as a download Steam left empty: the page hears it (library-item-changed
    // {downloadIncomplete: true}, as GET /library would say it) and its card greys, "Download incomplete" fading in over the
    // picture (off: opacity only), its preset status icon staying hidden (one sign, not two); a click plays nothing and the
    // status bar says why; its sidebar's notice says it with "Redownload" (enabled: every download mode can download, the
    // one rule, components/subscribeMode.ts actionBlocked); a click posts /library/redownload {path} (held): "Downloading…", disabled, a download-progress step under the
    // words; answered done → the words fade out (off: opacity only), the card and the notice come back. The words keep their
    // own fill under bg-live and lose their outer glow under no-glow. Shots side-incomplete-*.png
    for (const mode of ["on", "off"]) await cell(`lib:incomplete${mode === "off" ? "Off" : ""}`, async () => withPresets(async () => {
      const v = [], J = JSON.stringify, pb = preDir(PRE.base), page0 = `https://steamcommunity.com/sharedfiles/filedetails/?id=${PRE.base}`;
      const CHIP = `.card.lib:has([data-title="pb"]) .card-incomplete`;
      const chip = () => page(`const c = document.querySelector(${J(CHIP)}); if (!c) return null; const s = getComputedStyle(c), w = c.closest(".thumb-wrap").getBoundingClientRect(), r = c.getBoundingClientRect();
        return { on: c.classList.contains("on"), text: c.textContent.trim(), op: +s.opacity, bg: s.backgroundColor, sh: s.boxShadow, color: s.color, svg: !!c.querySelector("svg"),
          dx: Math.round((r.left + r.width / 2) - (w.left + w.width / 2)), inside: r.left >= w.left && r.right <= w.right };`);
      const cur0 = await current();
      try {
        if (mode === "off") await setMotion(false);
        const c0 = await chip(), s0 = await cardState("pb");
        if (!c0 || c0.on || s0?.off) return [`pb before: chip ${J(c0)}, card ${J(s0)} — want a whole, playable Workshop card (proved nothing)`];
        const samp = js(MO.SAMPLE({ chip: CHIP }, 1200));
        await sleep(40);
        await page(`window.__libPatch = { ${J(pb)}: { downloadIncomplete: true } };`);
        await js(`window.__fakeWs("library-item-changed", { path: ${J(pb)}, downloadIncomplete: true })`);
        const fr = await samp;
        console.log(`        motion ${mode}: chip ${MO.brief(fr.chip)}`);
        v.push(...MO.judge("the card's Download incomplete words", fr.chip, { appear: true, still: mode === "off", maxMs: mode === "on" ? 450 : 300 }));
        await sleep(300);
        const c1 = await chip(), s1 = await cardState("pb");
        console.log(`        card: ${J(s1)} chip ${J(c1)}`);
        if (!s1?.off || !/grayscale\(1\)/.test(s1.filter ?? "")) v.push(`pb's card isn't greyed: ${J(s1)}`);
        if (s1?.reason !== "" || s1?.op > 0.01) v.push(`pb's preset status icon shows too: ${J(s1)}`);
        if (!c1?.on || c1.text !== "Download incomplete" || c1.op < 0.99 || !c1.svg) v.push(`the card's words: ${J(c1)}, want "Download incomplete" with its glyph, shown`);
        if (c1 && (Math.abs(c1.dx) > 1 || !c1.inside)) v.push(`the words aren't centred on the picture: ${J(c1)}`);
        const warn = await page(`const d = document.createElement("div"); d.style.color = "var(--warn)"; document.body.appendChild(d); const c = getComputedStyle(d).color; d.remove(); return c;`);
        if (c1 && c1.color !== warn) v.push(`the words are ${c1.color}, want --warn ${warn}`);
        if (mode === "on") await shot("incomplete-card");
        // a click plays nothing, the status bar says why
        const th = await page(`const t = m.thumb("pb"); t.scrollIntoView({ block: "center" }); await m.sleep(300); return m.rect(t);`);
        const n1 = await reqMark();
        await clickAt(th.x + th.w / 2, th.y + th.h / 2); await sleep(500);
        if ((await reqsSince(n1)).some(([mt, p]) => mt === "POST" && p === "/apply")) v.push("a click on pb posted /apply");
        const st = await statusText();
        if (st !== "Can't play pb: download incomplete") v.push(`the status bar says ${J(st)}`);
        if ((await current()) !== cur0) v.push(`the playing wallpaper changed (${T(await current())})`);
        // its glow: the ring plus an outer --warn glow; no-glow: the ring alone; bg-live: its own fill
        const look = await page(`const root = document.documentElement, c = document.querySelector(${J(CHIP)}); root.classList.add("no-glow"); await m.sleep(60);
          const out = { noGlow: getComputedStyle(c).boxShadow }; root.classList.remove("no-glow"); const had = root.classList.contains("bg-live"); root.classList.add("bg-live"); await m.sleep(60);
          out.liveBg = getComputedStyle(c).backgroundColor; if (!had) root.classList.remove("bg-live"); return out;`);
        const outer = (sh) => (sh ?? "").split(/,(?![^(]*\))/).filter((x) => !/inset/.test(x) && x.trim() !== "none").length;
        if (!/inset/.test(c1?.sh ?? "") || outer(c1?.sh) !== 1) v.push(`the words don't glow (${c1?.sh})`);
        if (!/inset/.test(look.noGlow) || outer(look.noGlow) !== 0) v.push(`no-glow: ${look.noGlow}, want the ring alone`);
        if (alpha(look.liveBg) < 0.3) v.push(`bg-live: the words have no fill of their own (${look.liveBg})`);
        if (mode === "on") {
          await page(`document.documentElement.classList.add("no-glow");`); await sleep(250); await shot("incomplete-noglow");
          await page(`document.documentElement.classList.remove("no-glow"); document.documentElement.classList.add("bg-live");`); await sleep(250);
          await shot("incomplete-bglive"); await page(`document.documentElement.classList.remove("bg-live");`);
        }
        // the sidebar's notice and its Redownload
        await page(`await m.closeAll(); await m.openSide("pb"); await m.sleep(600);`);
        const note = await page(`const n = m.side().querySelector("[data-preset-note]"), b = n?.querySelector("[data-redownload]"); if (!n) return null;
          return { note: n.dataset.presetNote, text: n.querySelector(".side-crash-text")?.firstChild?.textContent.trim(), why: n.querySelector("[data-preset-why]")?.textContent.trim(),
            btn: b?.textContent.trim() ?? null, off: b?.getAttribute("aria-disabled") ?? null, get: !!n.querySelector("[data-preset-get]") };`);
        console.log(`        notice ${J(note)}`);
        if (!note || note.text !== "Download incomplete" || note.btn !== "Redownload" || note.off || note.get)
          v.push(`pb's notice: ${J(note)}, want "Download incomplete" with Redownload, enabled (no base download)`);
        if (mode === "on") await shot("incomplete-side");
        await page(`window.__redlHold = true;`);
        // Redownload: its path, held; the button busy, Steam's step under the words
        const br = await page(`return m.rect(m.side().querySelector("[data-redownload]"));`);
        await clickAt(br.x + br.w / 2, br.y + br.h / 2); await sleep(400);
        await js(`window.__fakeWs("download-progress", { id: ${J(page0)}, value: 0, status: "Steam is downloading it…" })`); await sleep(300);
        const sent = await js(`window.__redl.slice()`);
        const busy = await page(`const n = m.side().querySelector("[data-preset-note]"), b = n?.querySelector("[data-redownload]");
          return { text: b?.textContent.trim(), off: b?.getAttribute("aria-disabled"), why: n?.querySelector("[data-preset-why]")?.textContent.trim() };`);
        console.log(`        sent ${J(sent)}; busy ${J(busy)}`);
        if (sent.length !== 1 || sent[0].path !== pb) v.push(`${sent.length} redownloads sent (${J(sent)}), want one of pb's path`);
        if (busy.text !== "Downloading…" || busy.off !== "true" || busy.why !== "Steam is downloading it…") v.push(`while it runs: ${J(busy)}`);
        if (mode === "on") await shot("incomplete-busy");
        // done: the words fade out, the card comes back, the notice leaves
        const out = js(MO.SAMPLE({ chip: CHIP }, 1200));
        await sleep(40);
        await page(`window.__libPatch = null; window.__redlGo({ done: true, openedInSteam: false, message: "Downloaded again" });`);
        const fo = await out;
        console.log(`        done, motion ${mode}: chip ${MO.brief(fo.chip)}`);
        v.push(...MO.judge("the card's Download incomplete words", fo.chip, { leave: true, still: mode === "off", maxMs: mode === "on" ? 450 : 300 }));
        await sleep(500);
        const s2 = await cardState("pb"), c2 = await chip();
        const left = await page(`return !!m.side()?.querySelector("[data-preset-note]");`);
        if (!s2 || !c2) v.push(`pb's card is gone after the redownload: ${J(s2)} ${J(c2)}`);
        else if (s2.off || c2.on || c2.op > 0.01) v.push(`pb still greyed after the redownload: ${J(s2)} ${J(c2)}`);
        if (left) v.push("the notice stayed after the redownload");
        const sb = await statusText();
        if (sb !== "Downloaded again: pb") v.push(`the status bar says ${J(sb)}`);
      } finally {
        await page(`window.__redlHold = false; window.__redlGo?.({ done: false, openedInSteam: false, message: "" }); window.__libPatch = null; await m.closeAll();`).catch(() => {});
        if (mode === "off") await setMotion(true);
      }
      return v;
    }, { workshopDownloadMode: "steamapp" }));

    // lib:baseDelete:<on|off> — deleting pb, which pp1 and pp2 play, asks first: the card's Delete button, the Delete key on
    // a selection and the sidebar's Delete all open the dialog (the modal shell: zooms in, motion off fades in place) naming
    // 2 presets; Keep it / Escape delete nothing; Delete trashes pb (the sidebar closes after the answer) and both presets
    // grey out. The sidebar's "Delete and unsubscribe" asks the same (Unsubscribe). A scene no preset plays (s2) and a preset
    // itself (pp2) delete without asking (trash stubbed). The Delete button glows hovered (none under no-glow), the panel keeps
    // its fill under bg-live. Shots side-basedel-*.png
    for (const mode of ["on", "off"]) await cell(`lib:baseDelete${mode === "off" ? "Off" : ""}`, async () => withPresets(async () => {
      const v = [], J = JSON.stringify;
      try {
        if (mode === "off") await setMotion(false);
        const dlg = () => page(`const d = document.querySelector("[data-base-confirm]"); if (!d) return null;
          return { h: d.querySelector("h2")?.textContent.trim(), text: d.querySelector("[data-base-confirm-text]")?.textContent.trim(),
            keep: d.querySelector("[data-base-confirm-keep]")?.textContent.trim(), go: d.querySelector("[data-base-confirm-go]")?.textContent.trim(),
            focus: document.activeElement?.hasAttribute("data-base-confirm-keep") ?? false };`);
        const waitDlg = async (on) => { for (let i = 0; i < 40; i++) { if (!!(await dlg()) === on) return true; await sleep(50); } return false; };
        const trashes = (from) => reqsSince(from).then((l) => l.filter(([mt, p]) => mt === "POST" && p === "/library/trash").length);
        const WANT = "2 presets in your library use this scene. They stay, greyed out, until you download it again.";
        // 1. the card's Delete button
        let n0 = await reqMark();
        const samp = js(MO.SAMPLE({ panel: ".modal.base-confirm", back: "[data-base-confirm]" }, 900));
        await sleep(40);
        await page(`const c = m.card("pb"); c.scrollIntoView({ block: "center" }); c.querySelector(".del").click();`);
        const fr = await samp;
        console.log(`        motion ${mode}: panel ${MO.brief(fr.panel)}`);
        v.push(...MO.judge("the dialog", fr.panel, { appear: true, still: mode === "off", maxMs: mode === "on" ? 600 : 300 }));
        if (mode === "on" && !fr.panel.some((f) => f[1] != null && f[4] > 0 && fr.panel.at(-1)[4] - f[4] > 2)) v.push("motion on: the dialog didn't grow in");
        const d1 = await dlg();
        console.log(`        ${J(d1)}`);
        if (!d1) return [...v, "Delete on pb asked nothing"];
        if (d1.h !== "Delete “pb”?" || d1.text !== WANT || d1.keep !== "Keep it" || d1.go !== "Delete") v.push(`the dialog reads ${J(d1)}`);
        if (!d1.focus) v.push("Keep it isn't focused");
        if (mode === "on") await shot("basedel-dialog");
        // its look: the Delete button glows hovered, none under no-glow; the panel's own fill under bg-live
        const gr = await page(`return m.rect(document.querySelector("[data-base-confirm-go]"));`);
        await mv(gr.x + gr.w / 2, gr.y + gr.h / 2, 350);
        const look = await page(`const b = document.querySelector("[data-base-confirm-go]"), root = document.documentElement, out = { glow: getComputedStyle(b).boxShadow };
          root.classList.add("no-glow"); await m.sleep(250); out.noGlow = getComputedStyle(b).boxShadow; root.classList.remove("no-glow");
          const had = root.classList.contains("bg-live"); root.classList.add("bg-live"); await m.sleep(60);
          out.liveBg = getComputedStyle(document.querySelector(".modal.base-confirm")).backgroundColor; if (!had) root.classList.remove("bg-live"); return out;`);
        if (!visibleGlow2(look.glow)) v.push(`the hovered Delete doesn't glow (${look.glow})`);
        if (visibleGlow2(look.noGlow)) v.push(`no-glow: the hovered Delete still glows (${look.noGlow})`);
        if (alpha(look.liveBg) < 0.3) v.push(`bg-live: the dialog has no fill (${look.liveBg})`);
        if (mode === "on") {
          await page(`document.documentElement.classList.add("no-glow");`); await sleep(250); await shot("basedel-noglow");
          await page(`document.documentElement.classList.remove("no-glow"); document.documentElement.classList.add("bg-live");`); await sleep(250);
          await shot("basedel-bglive"); await page(`document.documentElement.classList.remove("bg-live");`);
        }
        await mv(5, 5);
        const out = js(MO.SAMPLE({ panel: ".modal.base-confirm" }, 900));
        await sleep(40);
        await page(`document.querySelector("[data-base-confirm-keep]").click();`);
        const fo = await out;
        v.push(...MO.judge("the dialog", fo.panel, { leave: true, still: mode === "off", maxMs: mode === "on" ? 600 : 300 }));
        await sleep(200);
        if (await trashes(n0)) v.push("Keep it deleted something");
        if (!(await libItem(preDir(PRE.base)))) v.push("pb is gone after Keep it");
        // 2. the Delete key on a selection (pb Ctrl-clicked), Escape answers
        n0 = await reqMark();
        await page(`m.thumb("pb").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true })); await m.sleep(200); m.key("Delete");`);
        if (!await waitDlg(true)) v.push("the Delete key on pb asked nothing");
        await page(`document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));`);
        if (!await waitDlg(false)) v.push("Escape didn't close the dialog");
        await sleep(200);
        if (await trashes(n0)) v.push("Escape deleted something");
        // 3. the sidebar's Delete and unsubscribe: the same question, as an unsubscribe; Keep it
        await page(`await m.closeAll(); await m.openSide("pb"); await m.sleep(400); m.side().querySelector("[data-delete-source]")?.click();`);
        const d3 = await waitDlg(true) ? await dlg() : null;
        if (!d3 || d3.h !== "Unsubscribe from “pb”?" || d3.go !== "Unsubscribe" || d3.text !== WANT) v.push(`Delete and unsubscribe asked ${J(d3)}`);
        await page(`document.querySelector("[data-base-confirm-keep]")?.click();`); await waitDlg(false);
        if (await page(`return !!window.__reqs.find(([m, p]) => p === "/workshop/delete-from-source");`)) v.push("Keep it still unsubscribed pb");
        if (!await page(`return m.sideTitle() === "pb";`)) v.push("the sidebar closed though nothing was deleted");
        // 4. the sidebar's Delete: Delete → pb trashed, both presets grey out, the sidebar closes
        n0 = await reqMark();
        await page(`m.sideBtn("Delete").click();`);
        if (!await waitDlg(true)) v.push("the sidebar's Delete asked nothing");
        await page(`document.querySelector("[data-base-confirm-go]").click();`);
        for (let i = 0; i < 40 && (await libItem(preDir(PRE.base))); i++) await sleep(100);
        await sleep(600);
        if (await trashes(n0) !== 1) v.push(`Delete sent ${await trashes(n0)} trash requests, want 1`);
        if (await libItem(preDir(PRE.base))) v.push("pb is still in the library after Delete");
        if (await page(`return !!m.side();`)) v.push("the sidebar stayed open on the deleted pb");
        for (const t of ["pp1", "pp2"]) { const c = await cardState(t); if (!c?.off || c.reason !== "Needs its base scene") v.push(`${t} after its base went: ${J(c)}`); }
        if (mode === "on") await shot("basedel-after");
        await post("/library/undo");
        // 5. no question: a scene no preset plays, a preset itself (trash stubbed: nothing really goes)
        await loadUi();
        await page(`window.__stubTrash = true;`);
        for (const t of ["s2", "pp2"]) {
          await page(`const c = m.card(${J(t)}); c.scrollIntoView({ block: "center" }); c.querySelector(".del").click(); await m.sleep(500);`);
          const asked = await dlg(), sent = await js(`window.__trashed.length`);
          if (asked) { v.push(`deleting ${t} asked ${J(asked)}`); await page(`document.querySelector("[data-base-confirm-keep]").click();`); await waitDlg(false); }
          else if (!sent) v.push(`deleting ${t} sent no trash`);
          await page(`window.__trashed = [];`);
        }
      } finally {
        await page(`window.__stubTrash = false; document.querySelector("[data-base-confirm-keep]")?.click();`).catch(() => {});
        if (mode === "off") await setMotion(true);
      }
      return v;
    }, { workshopDownloadMode: "steamapp" }));

    // ---- Browse: a local Wallpaper Engine folder: we1 (not in the library) + 900000001 (= s1's Workshop id: in the library)
    const we = path.join(path.dirname(path.dirname(path.dirname(path.dirname(K[0])))), "we-side");
    const ff = (args) => require("child_process").execFileSync("ffmpeg", ["-nostdin", "-loglevel", "error", "-y", ...args], { timeout: 60000 });
    for (const [id, title] of [["9101", "we1"], ["900000001", "s1-local"]]) {
      const d = path.join(we, id); fs.mkdirSync(d, { recursive: true });
      ff(["-f", "lavfi", "-i", "smptebars=size=480x480", "-frames:v", "1", path.join(d, "preview.jpg")]);
      ff(["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(d, "v.mp4")]);
      // Steam's kind of tags (look:sideTags): the category, the type, a genre, a resolution
      fs.writeFileSync(path.join(d, "project.json"), JSON.stringify({ title, type: "video", file: "v.mp4", preview: "preview.jpg",
        ...(title === "we1" ? { tags: ["Wallpaper", "Video", "Anime", "1920 x 1080", "Standard Definition"] } : {}) }));
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
    // item here is one) nor the type ("Video" / "Scene"), nor any tag of a group a pill it shows tells (the resolution:
    // "Standard Definition" too); a genre stays
    await cell("look:sideTags", async () => {
      const v = [];
      await page(`await m.closeAll();`); await sleep(200);
      const r = await page(`m.thumb("we1").click(); await m.waitSide("browse"); await m.sleep(500); const p = m.side();
        return { tags: [...p.querySelectorAll(".side-tags .tag")].map((e) => e.textContent.trim()),
          pills: [...p.querySelectorAll(".side-hero .side-pill")].map((e) => e.textContent.trim()) };`);
      console.log(`        ${JSON.stringify(r)}`);
      // any resolution pill (its text is the frame size) makes every resolution-group tag a repeat
      const resPill = r.pills.some((x) => /\d+\s*[×x]\s*\d+/.test(x));
      for (const t of ["Wallpaper", "Video"]) if (r.tags.includes(t)) v.push(`lists "${t}" (says nothing here)`);
      if (!r.tags.includes("Anime")) v.push(`the genre "Anime" is missing (tags ${JSON.stringify(r.tags)})`);
      for (const t of ["1920 x 1080", "Standard Definition"]) {
        if (resPill && r.tags.includes(t)) v.push(`lists "${t}" though a resolution pill shows`);
        if (!resPill && !r.tags.includes(t)) v.push(`hid "${t}" though no resolution pill shows`);
      }
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
      // the arrow drops once and lands (only progress loops — .claude/rules/ui/design.md § Icon motion)
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
