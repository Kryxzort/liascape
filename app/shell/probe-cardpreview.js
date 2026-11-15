// Settings' live card preview probe — `scripts/test-ui-matrix.sh --probe probe-cardpreview.js` (the matrix's hermetic stack:
// private backend + headless liascape-player + this tree's UI; LIASCAPE_MATRIX_SCREEN=1920x1080 for the 1920 px pictures).
// The preview (app/ui/src/components/CardPreview.tsx) beside Settings → Look & feel's card rows:
//   cardpv:present     only while the card rows are on screen; real library cards (one video-only, one with a gif + video)
//   cardpv:shape       "Thumbnail shape" 1:1 / 16:9 → the cards' shape, live
//   cardpv:size        "Card size" → the cards' width, live, Medium = the Library grid's own card width
//   cardpv:preset      Basic: "Card previews" (a preset dropdown, no lists) sets both orders, live on the cards; a hidden
//                      order a preset names isn't "tucked away"; Standard: the two lists show, an order no preset has
//                      reads "Custom" (Basic too, and then it is tucked away), a preset picked again puts the lists back
//   cardpv:order       "On hover" / "Not hovered": for several orders, what the video-only and the gif + video card show
//                      unhovered and hovered (the first one each card has; nothing after "Still image")
//   cardpv:orderCtl    the lists' control: the move buttons by keyboard (focus stays on a usable button), a drag, the dimmed
//                      unreachable items; motion on: the items glide; motion off: they jump (no in-between frame), only the
//                      dimming fades; no-glow: no glow on a hovered item; bg-live: a translucent item
//   cardpv:quality     "Video preview quality" → the preview plays exactly the chosen quality: a High sample within 3 s of
//                      choosing it (not the full-length re-encode), a Low clip after High (other fps and size than High's,
//                      before the library's clip follows the choice); the caption says "making the High preview…", then the
//                      backend's fps and size for it
//   cardpv:hover       a hover hands the clip over to the real file and back
//   cardpv:noApply     clicks, double-clicks, right-clicks and keys apply, play, add or open nothing; the aria says so
//   cardpv:offscreen   scrolled away: no card, no media, no clip request; window inactive: nothing plays
//   cardpv:motion      motion on: it fades in and a size change morphs; "Smooth window animations" off: it fades in in
//                      place (opacity only, in-between frames, no transform), the size changes at once, and
//                      the cards stay whole, on screen, playing and handing over on hover — also after a toggle in the middle
//                      of a morph and after a reload
//   cardpv:noGlow      "Glow effects" off: the frame's hover glow goes; bg-live: still a translucent card
//   cardpv:noOverflow  1920 px: beside the rows, pinned while they scroll; 960 px: above them; never wider than the page
// Pictures: cardpv-1920.png, cardpv-960.png (+ -hover, -16x9, -noglow) in $LIASCAPE_OUT. Exit 1 on any FAIL.
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

const E = process.env;
const U = E.LIASCAPE_URL;
const { withToken, authHeaders } = require("./api-auth"); // the backend's API token (.claude/rules/backend/api.md § Security)
const OUT = E.LIASCAPE_OUT;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// the preview orders' defaults (app/ui/src/components/mediaAssets.ts), and "Always animate": every card plays its GIF, else its
// video, unhovered — what the cells below play their clips under
const ON_HOVER = ["gif", "video", "image"], NOT_HOVERED = ["image", "gif", "video"], ALWAYS = ["gif", "video", "image"];
app.setPath("userData", path.join(OUT, "electron-user-data"));
// a page replaced under the probe leaves its promises pending: the whole run has a ceiling (.claude/rules/testing.md)
setTimeout(() => { console.log("ERROR probe-cardpreview: overall timeout"); app.exit(2); }, 12 * 60 * 1000).unref();

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
const send = (e) => win.webContents.sendInputEvent(e);
const shot = async (name) => fs.writeFileSync(path.join(OUT, `cardpv-${name}.png`), (await win.webContents.capturePage()).toPNG());

const HELPERS = `
  window.__pv = {
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    label: (r) => r.querySelector(".slabel-row")?.firstChild?.textContent?.trim(),
    row(label) { return [...document.querySelectorAll(".settings .srow")].find((r) => this.label(r) === label); },
    sc: () => document.querySelector(".settings"),
    host: () => document.querySelector("[data-card-preview]"),
    frame: () => document.querySelector("[data-card-preview] .card-pv-frame"),
    cards: () => [...document.querySelectorAll("[data-card-preview] .card.lib")],
    slot: (kind) => document.querySelector('[data-card-preview] .card-pv-slot[data-pv-kind="' + kind + '"]'),
    card(kind) { return this.slot(kind)?.querySelector(".card.lib") ?? null; },
    async settingsTab() {
      [...document.querySelectorAll(".tab")].find((t) => t.textContent.trim() === "Settings")?.click();
      for (let i = 0; i < 60 && !document.querySelector(".settings .srow"); i++) await this.sleep(100);
      await this.sleep(400);
    },
    async toRows() { document.querySelector(".pv-rows")?.scrollIntoView({ block: "center" }); await this.sleep(700); },
    async toTop() { const s = this.sc(); if (s) s.scrollTop = 0; await this.sleep(700); },
    async check(label, on) { const i = this.row(label)?.querySelector("input[type=checkbox]"); if (i && i.checked !== on) i.click(); await this.sleep(350); return !!i; },
    async select(label, opt) {
      this.row(label)?.querySelector(".sel")?.click(); await this.sleep(250);
      [...document.querySelectorAll(".sel-pop .sel-opt")].find((e) => e.textContent.trim() === opt)?.click(); await this.sleep(400);
    },
    // an order list's items, top first (components/OrderList.tsx data-ord), and putting it in an order by its move buttons
    ord(label) { return this.row(label)?.querySelector(".ord")?.dataset.ord?.split(",") ?? null; },
    async order(label, want) {
      for (let n = 0; n < 12; n++) {
        const cur = this.ord(label); if (!cur) return false;
        if (cur.join() === want.join()) { await this.sleep(350); return true; }
        const id = want.find((k, j) => cur[j] !== k);
        this.row(label).querySelector('[data-ord-id="' + id + '"] [data-ord-move="up"]')?.click();
        await this.sleep(80);
      }
      return false;
    },
    selVal(label) { return this.row(label)?.querySelector(".sel .sel-val")?.textContent?.trim() ?? null; },
    async seg(label, opt) { [...(this.row(label)?.querySelectorAll(".seg-opt") ?? [])].find((b) => b.textContent.trim() === opt)?.click(); await this.sleep(350); },
    layers(kind) {
      const c = this.card(kind); if (!c) return null;
      const v = c.querySelector("video.thumb.anim");
      const g = [...c.querySelectorAll("img.thumb.anim")].find((i) => getComputedStyle(i).visibility !== "hidden");
      return { video: !!v, src: v?.getAttribute("src") || "", playing: !!v && !v.paused && v.readyState >= 2, gif: !!g };
    },
    box(el) { if (!el) return null; const b = el.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height, x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; },
    caption: () => document.querySelector("[data-card-preview] .card-pv-cap")?.textContent?.trim() ?? null,
    clipAsks() { return performance.getEntriesByType("resource").map((e) => e.name).filter((n) => n.includes("/clip?") && n.includes("info=1")); },
  }; true`;
async function loadSettings() {
  await win.loadURL(withToken(U + "/"));
  for (let i = 0; i < 100 && !(await js(`return !!document.querySelector(".tab")`)); i++) await sleep(100);
  await js(HELPERS);
  await js(`performance.setResourceTimingBufferSize(20000); await window.__pv.settingsTab(); return true`);
}
const pv = (expr) => js(`const p = window.__pv; ${expr}`);
// the preview on screen with at least two real cards, else the cell proves nothing
async function needCards(v, what) {
  await pv(`await p.toRows(); return true`);
  const ok = await waitFor(async () => (await pv(`return p.cards().length`)) >= 2, 4000);
  if (!ok) v.push(`${what}: no preview cards on screen (${await pv(`return p.host() ? "a preview, " + p.cards().length + " cards" : "no [data-card-preview]"`)}) — proved nothing`);
  return ok;
}
// the clip a video card plays: its file name (`v`, the backend's Web/ClipStore.cs NameFor:
// <item>_<stamp>_<width>_<quality 0 low | 1 mid | 2 high>_<full|short>) and, read from the file served, its fps, width and bytes
const clipStem = (kind) => pv(`const s = p.layers(${JSON.stringify(kind)})?.src || ""; const m = /[?&]v=([^&]+)/.exec(s); return m ? decodeURIComponent(m[1]) : null`);
const qOf = (stem) => (/_([0-2])_(full|short)$/.exec(stem || "") || [])[1] ?? null;
function clipFacts(stem) {
  const f = path.join(E.HOME || "", ".cache", "liascape", "video_clips", stem + ".mp4");
  try {
    const out = require("child_process").execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries",
      "stream=width,avg_frame_rate", "-of", "json", f], { timeout: 15000 }).toString();
    const s = JSON.parse(out).streams[0], [n, d] = s.avg_frame_rate.split("/").map(Number);
    return { stem, w: s.width, fps: Math.round((n / (d || 1)) * 10) / 10, bytes: fs.statSync(f).size };
  } catch (e) { return { stem, error: e.message.slice(0, 120) }; }
}
const move = async (x, y) => { send({ type: "mouseMove", x: x - 3, y }); await sleep(40); send({ type: "mouseMove", x, y }); };

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
    // Advanced: "Wallpaper behind every tab" (bg-live) is an Advanced row
    await http("POST", "/settings", { SettingsLevel: "advanced", ThumbnailAspect: "1:1", CardSize: "Medium",
      PreviewOnHover: ON_HOVER, PreviewNotHovered: NOT_HOVERED, VideoPreviewQuality: "mid", Glows: true, Morphs: true, LiveWallpaperBehindAllTabs: false });
    await loadSettings();

    await cell("cardpv:present — only while the card rows are on screen; real library cards", async () => {
      const v = [];
      const top = await pv(`return { host: !!p.host(), cards: p.cards().length, on: p.host()?.hasAttribute("data-on") ?? null }`);
      if (top.cards) v.push(`at the top of Settings (the card rows off screen): ${top.cards} preview cards mounted`);
      if (!(await needCards(v, "rows on screen"))) return v;
      const on = await pv(`return { on: p.host().hasAttribute("data-on"), kinds: [...document.querySelectorAll("[data-card-preview] .card-pv-slot")].map((s) => s.dataset.pvKind),
        titles: p.cards().map((c) => c.querySelector(".lib-title")?.dataset.title), real: p.cards().every((c) => c.querySelector(".thumb-wrap img.thumb")) }`);
      if (!on.on) v.push("rows on screen but the preview isn't marked on (data-on)");
      if (!on.kinds.includes("video") || !on.kinds.includes("both")) v.push(`picked kinds ${JSON.stringify(on.kinds)} (want a video-only and a gif + video item; the library has both)`);
      if (!on.real) v.push("a preview card lacks the library card's thumbnail (not the real LibraryCard)");
      await pv(`await p.toTop(); return true`);
      const gone = await waitFor(async () => (await pv(`return p.cards().length`)) === 0, 2000);
      if (!gone) v.push(`scrolled back to the top: ${await pv(`return p.cards().length`)} cards still mounted`);
      await pv(`p.sc().scrollTop = p.sc().scrollHeight; await p.sleep(700); return true`);
      const below = await pv(`return p.cards().length`);
      if (below) v.push(`scrolled to the bottom (past the rows): ${below} cards mounted`);
      return v;
    });

    await cell("cardpv:shape — Thumbnail shape reshapes the preview cards live", async () => {
      const v = [];
      if (!(await needCards(v, "shape"))) return v;
      const ratio = () => pv(`const b = p.box(p.card("video")); return b ? +(b.w / b.h).toFixed(3) : null`);
      const sq = await ratio();
      await pv(`await p.select("Thumbnail shape", "Widescreen (16:9)"); await p.toRows(); return true`);
      const okWide = await waitFor(async () => Math.abs((await ratio()) - 16 / 9) < 0.03, 3000);
      const wide = await ratio();
      await shot("16x9");
      await pv(`await p.select("Thumbnail shape", "Square (1:1)"); await p.toRows(); return true`);
      const okSq = await waitFor(async () => Math.abs((await ratio()) - 1) < 0.03, 3000);
      if (Math.abs(sq - 1) > 0.03) v.push(`1:1 at the start: card ratio ${sq}`);
      if (!okWide) v.push(`16:9 chosen: card ratio ${wide}, want 1.778`);
      if (!okSq) v.push(`back to 1:1: card ratio ${await ratio()}`);
      return v;
    });

    await cell("cardpv:size — Card size resizes the preview cards live; Medium matches the Library grid", async () => {
      const v = [];
      if (!(await needCards(v, "size"))) return v;
      const width = () => pv(`return Math.round(p.box(p.slot("video"))?.w ?? 0)`);
      const w = {};
      for (const s of ["Small", "Large", "Medium"]) {
        await pv(`await p.select("Card size", ${JSON.stringify(s)}); await p.toRows(); await p.sleep(500); return true`);
        w[s] = await width();
      }
      if (!(w.Small < w.Medium && w.Medium < w.Large)) v.push(`card widths Small ${w.Small} / Medium ${w.Medium} / Large ${w.Large} px — want growing`);
      // the Library grid's card at Medium, same window
      await js(`[...document.querySelectorAll(".tab")].find((t) => t.textContent.trim() === "Library")?.click(); await new Promise((r) => setTimeout(r, 900)); return true`);
      const lib = await js(`const c = document.querySelector('.app[data-page="library"] .lib-scroll .card.lib'); return c ? Math.round(c.getBoundingClientRect().width) : 0`);
      await pv(`await p.settingsTab(); return true`);
      if (!lib) v.push("no Library card to compare with");
      // the Library's grid may have no scrollbar (10 px wider), spread over its columns
      else if (Math.abs(lib - w.Medium) > 4) v.push(`Medium: preview card ${w.Medium} px, the Library grid's ${lib} px`);
      return v;
    });

    // what a card shows for an order (app/ui/src/components/mediaAssets.ts firstPreview): the first kind it has, "image" ends it
    const HAS = { video: { video: true, gif: false }, both: { video: true, gif: true } };
    const first = (order, kind) => order.find((k) => k === "image" || HAS[kind][k]);
    // its layers match: video = a video playing (a clip unhovered, the real file hovered), gif = the gif and no video, image = neither
    const shows = (l, want, hovered) => !!l && (want === "video" ? l.playing && l.src.includes(hovered ? "/media?" : "/clip?")
      : want === "gif" ? l.gif && !l.video : !l.gif && !l.video);
    const hoverCard = async (kind) => { const b = await pv(`return p.box(p.card(${JSON.stringify(kind)})?.querySelector(".thumb-wrap"))`); if (b) await move(b.x, b.y); return !!b; };
    const unhover = () => move(5, 5);

    await cell("cardpv:preset — Basic's Card previews sets both orders live; Standard shows the lists, and an order no preset has reads Custom", async () => {
      const v = [], J = JSON.stringify;
      const orders = async () => { const s = (await http("GET", "/settings")).json || {}; return [s.previewOnHover, s.previewNotHovered]; };
      const reachOf = (o) => (o || []).slice(0, (o || []).indexOf("image") + 1).join(",");
      // through the top bar's level picker (a body posted behind the page's back loses to the page's next whole-settings save)
      const level = async (lv) => { await pv(`document.querySelector('[data-settings-level] [data-level="${lv}"]')?.click(); await p.sleep(300); return true`);
        return waitFor(async () => (await pv(`return !!p.row("On hover")`)) === (lv !== "basic"), 4000); };
      if (!(await needCards(v, "preset"))) return v;
      if (!(await level("basic"))) v.push("Basic: the On hover / Not hovered rows still show");
      const basic = await pv(`return { preset: !!p.row("Card previews"), val: p.selVal("Card previews"), lists: !!p.row("On hover") || !!p.row("Not hovered") }`);
      if (!basic.preset) return [...v, "Basic: no Card previews row"];
      if (basic.lists) v.push("Basic: the order lists show (they're Standard rows)");
      if (basic.val !== "Animate on hover") v.push(`Basic, the defaults: the preset reads ${J(basic.val)}, want "Animate on hover"`);
      // the "tucked away" count at Basic (the probe's own Advanced choices hide there too): a preset adds nothing to it
      const tucked = () => pv(`return +(document.querySelector("[data-hidden-changed]")?.dataset.hiddenChanged ?? 0)`);
      const base = await tucked();
      // each preset: both orders saved, the cards follow at once, nothing tucked away
      const PRE = { "Never animate": [NOT_HOVERED, NOT_HOVERED], "Always animate": [ALWAYS, ALWAYS],
        "Always animate, video first": [["video", "gif", "image"], ["video", "gif", "image"]], "Animate on hover": [ON_HOVER, NOT_HOVERED] };
      for (const [name, [hov, idle]] of Object.entries(PRE)) {
        await pv(`await p.toRows(); await p.select("Card previews", ${J(name)}); await p.toRows(); return true`);
        const saved = await waitFor(async () => { const [h, i] = await orders(); return reachOf(h) === reachOf(hov) && reachOf(i) === reachOf(idle); }, 4000);
        if (!saved) v.push(`Basic, "${name}": saved ${J(await orders())}, want ${J([hov, idle])}`);
        for (const kind of ["video", "both"]) {
          const want = first(idle, kind);
          if (!(await waitFor(async () => shows(await pv(`return p.layers(${J(kind)})`), want, false), want === "video" ? 15000 : 4000, 200)))
            v.push(`Basic, "${name}": the ${kind} card shows ${J(await pv(`return p.layers(${J(kind)})`))}, want its ${want}`);
        }
        const n = await tucked();
        if (n !== base) v.push(`Basic, "${name}": ${n} settings tucked away, ${base} with the defaults — a preset's orders show on Basic, they aren't tucked away`);
        const val = await pv(`return p.selVal("Card previews")`);
        if (val !== name) v.push(`Basic, "${name}" picked: the preset reads ${J(val)}`);
      }
      // Standard: the lists; an order no preset has → Custom (its hint names the lists); back at Basic it's Custom and tucked away
      if (!(await level("standard"))) v.push("Standard: no On hover / Not hovered rows");
      await pv(`await p.toRows(); return true`);
      const lists = await pv(`return [p.ord("On hover"), p.ord("Not hovered")]`);
      if (J(lists) !== J([ON_HOVER, NOT_HOVERED])) v.push(`Standard, the defaults: the lists read ${J(lists)}, want ${J([ON_HOVER, NOT_HOVERED])}`);
      await pv(`await p.order("Not hovered", ["video", "image", "gif"]); return true`);
      const custom = await waitFor(async () => (await pv(`return p.selVal("Card previews")`)) === "Custom", 3000);
      const hint = await pv(`return p.row("Card previews")?.querySelector(".shint")?.textContent ?? ""`);
      if (!custom) v.push(`Not hovered video, image: the preset reads ${J(await pv(`return p.selVal("Card previews")`))}, want "Custom"`);
      if (!/lists below/.test(hint)) v.push(`Custom at Standard: hint ${J(hint)} doesn't point at the lists`);
      if (!(await waitFor(async () => J((await orders())[1]) === J(["video", "image", "gif"]), 3000))) v.push(`the list's order wasn't saved: ${J(await orders())}`);
      await level("basic");
      const b2 = await pv(`return { val: p.selVal("Card previews") }`), n2 = await tucked();
      if (b2.val !== "Custom") v.push(`Basic with a custom order: the preset reads ${J(b2.val)}, want "Custom"`);
      // Not hovered differs from its default, On hover doesn't: one more setting tucked away
      if (n2 !== base + 1) v.push(`Basic with a custom Not hovered: ${n2} settings tucked away, want ${base + 1} (the hidden list that holds it)`);
      // a preset picked from Custom puts both lists back, and Custom leaves the choices
      await pv(`await p.toRows(); await p.select("Card previews", "Animate on hover"); return true`);
      const back = await waitFor(async () => { const [h, i] = await orders(); return J(h) === J(ON_HOVER) && J(i) === J(NOT_HOVERED); }, 4000);
      if (!back) v.push(`"Animate on hover" picked from Custom: saved ${J(await orders())}`);
      await pv(`p.row("Card previews")?.querySelector(".sel")?.click(); await p.sleep(250); return true`);
      const opts = await pv(`const o = [...document.querySelectorAll(".sel-pop .sel-opt")].map((e) => e.textContent.trim()); document.querySelector(".sel-backdrop")?.click(); await p.sleep(200); return o`);
      if (opts.includes("Custom")) v.push(`a preset chosen: the choices still offer Custom ${J(opts)}`);
      if (J(opts) !== J(["Never animate", "Animate on hover", "Always animate", "Always animate, video first"])) v.push(`the presets offered: ${J(opts)}`);
      await level("advanced");
      return v;
    });

    await cell("cardpv:order — On hover / Not hovered: each card shows the first kind it has, hovered and not", async () => {
      const v = [], J = JSON.stringify;
      if (!(await needCards(v, "order"))) return v;
      const COMBOS = [
        [["video", "gif", "image"], ["gif", "video", "image"]],
        [["gif", "video", "image"], ["video", "gif", "image"]],
        [["image", "video", "gif"], ["video", "image", "gif"]],
        [["video", "image", "gif"], ["gif", "image", "video"]],
        [ON_HOVER, NOT_HOVERED],
      ];
      let hovered = 0;
      for (const [hov, idle] of COMBOS) {
        const n = `On hover ${hov.join(">")}, Not hovered ${idle.join(">")}`;
        await pv(`await p.toRows(); await p.order("On hover", ${J(hov)}); await p.order("Not hovered", ${J(idle)}); return true`);
        for (const kind of ["video", "both"]) {
          const wi = first(idle, kind), wh = first(hov, kind);
          if (!(await waitFor(async () => shows(await pv(`return p.layers(${J(kind)})`), wi, false), wi === "video" ? 15000 : 4000, 200)))
            v.push(`${n}: the ${kind} card unhovered shows ${J(await pv(`return p.layers(${J(kind)})`))}, want its ${wi}`);
          if (!(await hoverCard(kind))) { v.push(`${n}: no ${kind} card to hover`); continue; }
          const ok = await waitFor(async () => shows(await pv(`return p.layers(${J(kind)})`), wh, true), 6000, 150);
          if (ok) hovered++;
          else v.push(`${n}: the ${kind} card hovered shows ${J(await pv(`return p.layers(${J(kind)})`))}, want its ${wh}`);
          await unhover(); await sleep(300);
        }
      }
      await pv(`await p.order("On hover", ${J(ON_HOVER)}); await p.order("Not hovered", ${J(NOT_HOVERED)}); return true`);
      if (!hovered) v.push("no hover showed what it should — proved nothing");
      return v;
    });

    await cell("cardpv:orderCtl — the lists' move buttons (keyboard), drag, unreachable items; motion on glides, off jumps; no-glow; bg-live", async () => {
      const v = [], J = JSON.stringify;
      if (!(await needCards(v, "orderCtl"))) return v;
      const list = (label) => `p.row(${J(label)})?.querySelector(".ord")`;
      const item = (label, id) => `${list(label)}?.querySelector('[data-ord-id="${id}"]')`;
      // per-frame top of each item (relative to the list, in list order) while `act` runs
      const sampled = (label, act, ms = 700) => pv(`const l = ${list(label)}; const kids = [...l.children]; const s = []; let run = true;
        const tick = () => { if (!run) return; const lt = l.getBoundingClientRect().top; s.push(kids.map((c) => +(c.getBoundingClientRect().top - lt).toFixed(1))); requestAnimationFrame(tick); };
        requestAnimationFrame(tick); ${act}; await p.sleep(${ms}); run = false; return s`);
      // frames where an item sits strictly between its first and last place: a glide passes through them, a jump never
      const between = (frames) => {
        if (frames.length < 2) return 0;
        const a = frames[0], b = frames[frames.length - 1];
        return frames.filter((f) => f.some((y, i) => Math.min(a[i], b[i]) + 1 < y && y < Math.max(a[i], b[i]) - 1)).length;
      };
      const drag = async (fromId, toId, edge) => {
        const f = await pv(`return p.box(${item("Not hovered", fromId)}?.querySelector(".ord-label"))`), t = await pv(`return p.box(${item("Not hovered", toId)})`);
        const y1 = Math.round(edge === "top" ? t.t + 2 : t.b - 2);
        await move(f.x, f.y); win.webContents.sendInputEvent({ type: "mouseDown", x: f.x, y: f.y, button: "left", clickCount: 1 });
        for (let i = 1; i <= 12; i++) { win.webContents.sendInputEvent({ type: "mouseMove", x: f.x, y: Math.round(f.y + (y1 - f.y) * i / 12), button: "left", modifiers: ["leftButtonDown"] }); await sleep(30); }
        await sleep(150);
        return async () => { win.webContents.sendInputEvent({ type: "mouseUp", x: f.x, y: y1, button: "left", clickCount: 1 }); await sleep(50); };
      };
      await pv(`await p.toRows(); await p.order("Not hovered", ${J(NOT_HOVERED)}); ${list("Not hovered")}.scrollIntoView({ block: "center" }); await p.sleep(400); return true`);
      // unreachable: everything below "Still image" is dimmed
      const dim = await pv(`return [...${list("Not hovered")}.children].map((c) => ({ id: c.dataset.ordId, un: c.hasAttribute("data-unreached"), op: +getComputedStyle(c).opacity }))`);
      if (J(dim.map((d) => d.un)) !== J([false, true, true])) v.push(`image first: unreached marks ${J(dim)}, want the two below it`);
      if (dim.slice(1).some((d) => d.op > 0.6)) v.push(`image first: the unreachable items aren't dimmed ${J(dim)}`);
      // keyboard: GIF's "up" focused as by Tab, Enter: GIF goes to the top, gliding; focus moves to its "down" (its "up" is disabled there)
      await pv(`document.documentElement.classList.add("kbd-nav"); ${item("Not hovered", "gif")}.querySelector('[data-ord-move="up"]').focus(); return true`);
      const glideP = sampled("Not hovered", "", 700);
      win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" }); win.webContents.sendInputEvent({ type: "char", keyCode: "\r" }); win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
      const glide = await glideP;
      const k1 = await pv(`return { ord: p.ord("Not hovered"), focus: document.activeElement?.closest(".ord-item")?.dataset.ordId ?? null, btn: document.activeElement?.dataset.ordMove ?? null }`);
      if (J(k1.ord) !== J(["gif", "image", "video"])) v.push(`Enter on GIF's up: ${J(k1.ord)}, want gif,image,video`);
      if (k1.focus !== "gif" || k1.btn !== "down") v.push(`GIF at the top: focus on ${J(k1)}, want GIF's down button (up is disabled there)`);
      if (!between(glide)) v.push(`motion on: no in-between frame while GIF moved up (${glide.length} frames ${J(glide.slice(0, 6))})`);
      const unr = await pv(`return [...${list("Not hovered")}.children].map((c) => c.hasAttribute("data-unreached"))`);
      if (J(unr) !== J([false, false, true])) v.push(`gif, image, video: unreached marks ${J(unr)}, want only video's`);
      await shot("order-moved");
      // drag (motion on): "Video" (last) above "GIF" (first); the others glide aside
      const dragOnP = sampled("Not hovered", "", 1300);
      const dropOn = await drag("video", "gif", "top");
      await shot("order-drag");
      await dropOn();
      const dragOn = await dragOnP; await move(5, 5); await sleep(400);
      const dragged = await pv(`return p.ord("Not hovered")`);
      if (J(dragged) !== J(["video", "gif", "image"])) v.push(`Video dragged above GIF: ${J(dragged)}, want video,gif,image`);
      if (!between(dragOn.map((f) => f.slice(0, 2)))) v.push(`motion on, a drag: the others never glided aside (${J(dragOn.slice(0, 8))})`);
      if (!(await waitFor(async () => J((await http("GET", "/settings")).json?.previewNotHovered) === J(["video", "gif", "image"]), 3000))) v.push("the dragged order wasn't saved");
      // no-glow: a hovered item has no glow; with it, it glows
      const hoverShadow = async () => {
        const b = await pv(`return p.box(${item("Not hovered", "image")})`); await move(b.x, b.y); await sleep(350);
        const sh = await pv(`return getComputedStyle(${item("Not hovered", "image")}).boxShadow`); await move(5, 5); await sleep(200); return sh;
      };
      const glowOn = await hoverShadow();
      await pv(`await p.check("Glow effects", false); ${list("Not hovered")}.scrollIntoView({ block: "center" }); await p.sleep(300); return true`);
      const glowOff = await hoverShadow();
      await pv(`await p.check("Glow effects", true); return true`);
      if (!glowOn || glowOn === "none") v.push(`glow on: a hovered item has no glow (${glowOn}), the no-glow check proves nothing`);
      if (glowOff && glowOff !== "none") v.push(`no-glow: a hovered item still glows (${glowOff})`);
      // bg-live: the item's fill is translucent
      await pv(`await p.check("Wallpaper behind every tab", true); ${list("Not hovered")}.scrollIntoView({ block: "center" }); await p.sleep(400); return true`);
      const bl = await pv(`return { live: document.documentElement.classList.contains("bg-live"), bg: getComputedStyle(${item("Not hovered", "gif")}).backgroundColor }`);
      await shot("order-bglive");
      await pv(`await p.check("Wallpaper behind every tab", false); return true`);
      const alpha = +(/rgba?\([^)]*,\s*([0-9.]+)\)$/.exec(bl.bg)?.[1] ?? /\/\s*([0-9.]+)\s*\)$/.exec(bl.bg)?.[1] ?? 1);
      if (!bl.live) v.push("bg-live: Wallpaper behind every tab didn't set bg-live, proved nothing");
      else if (!(alpha < 1)) v.push(`bg-live: the item's fill is opaque (${bl.bg})`);
      // motion off: a button move jumps (no in-between frame), the item's transition never moves it
      await pv(`await p.check("Smooth window animations", false); ${list("Not hovered")}.scrollIntoView({ block: "center" }); await p.sleep(300); return true`);
      const off = await sampled("Not hovered", `${item("Not hovered", "image")}.querySelector('[data-ord-move="up"]').click()`, 500);
      const tr = await pv(`const c = getComputedStyle(${item("Not hovered", "image")}); return { p: c.transitionProperty, d: c.transitionDuration }`);
      const offOrd = await pv(`return p.ord("Not hovered")`);
      await shot("order-motionoff");
      // a drag with motion off: "Video" (top) dragged below "Still image"; the others jump aside, no in-between frame
      const dragOffP = sampled("Not hovered", "", 1300);
      const dropOff = await drag("video", "image", "bottom");
      await dropOff();
      const dOff = await dragOffP; await move(5, 5); await sleep(300);
      const offDragOrd = await pv(`return p.ord("Not hovered")`);
      await pv(`await p.check("Smooth window animations", true); await p.order("Not hovered", ${J(NOT_HOVERED)}); return true`);
      if (J(offOrd) !== J(["video", "image", "gif"])) v.push(`motion off, Still image's up: ${J(offOrd)}, want video,image,gif`);
      if (between(off)) v.push(`motion off: ${between(off)} in-between frames while Still image moved up (want a jump) ${J(off.slice(0, 6))}`);
      if (/transform|translate|all/.test(tr.p)) v.push(`motion off: the item's transition moves it (${J(tr)})`);
      if (J(offDragOrd) !== J(["image", "video", "gif"])) v.push(`motion off, Video dragged below Still image: ${J(offDragOrd)}, want image,video,gif`);
      const others = dOff.map((f) => f.slice(1));
      if (!others.some((f) => J(f) !== J(others[0]))) v.push("motion off, a drag: nothing moved aside, proved nothing");
      else if (between(others)) v.push(`motion off, a drag: the others glided (${between(others)} in-between frames ${J(others.slice(0, 8))})`);
      return v;
    });

    await cell("cardpv:quality — the preview plays the chosen quality: High within seconds, Low after High; the caption says what it costs", async () => {
      const v = [], J = JSON.stringify;
      if (!(await needCards(v, "quality"))) return v;
      const qs = (await http("GET", "/clip/qualities")).json?.qualities ?? [];
      const hi = qs.find((x) => x.name === "high"), mid = qs.find((x) => x.name === "mid");
      if (!hi || !mid) return [`GET /clip/qualities: ${J(qs)}`];
      await pv(`await p.order("Not hovered", ${JSON.stringify(ALWAYS)}); return true`);
      // the library's full Mid clip first, as on a user's machine: a quality change then has a stored clip to differ from
      const midFull = await waitFor(async () => /_1_full$/.test((await clipStem("video")) || ""), 30000, 300);
      const capMid = await pv(`return p.caption()`);
      await pv(`performance.clearResourceTimings(); return true`);
      // every caption text the page shows from here on, however briefly (a sample can be made in a few hundred ms)
      await pv(`const cap = document.querySelector("[data-card-preview] .card-pv-cap"); window.__pvCaps = [];
        window.__pvCapObs?.disconnect(); window.__pvCapObs = new MutationObserver(() => window.__pvCaps.push(cap.textContent.trim()));
        window.__pvCapObs.observe(cap, { childList: true, subtree: true, characterData: true }); return true`);
      const t0 = Date.now();
      await pv(`await p.seg("Video preview quality", "High"); return true`);
      const caps = new Set();
      let tHigh = null, final = false;
      while (Date.now() - t0 < 25000) {
        const c = await pv(`return p.caption()`); caps.add(c);
        if (tHigh == null && qOf(await clipStem("video")) === "2" && (await pv(`return p.layers("video")?.playing`))) tHigh = Date.now() - t0;
        if (tHigh != null && /^High · \d+ fps · ~[\d.]+ MB per wallpaper$/.test(c)) { final = true; break; }
        await sleep(100);
      }
      const last = await pv(`return p.caption()`);
      for (const c of await pv(`window.__pvCapObs?.disconnect(); return window.__pvCaps ?? []`)) caps.add(c);
      const hiFacts = clipFacts(await clipStem("video"));
      const asks = await pv(`return p.clipAsks()`);
      const hiAsk = asks.some((n) => /[?&]q=high(&|$)/.test(n)), midAsk = asks.some((n) => /[?&]q=mid(&|$)/.test(n));
      // Low after High: the library's clip follows only once the choice settles (Web/ClipStore.cs), the preview shows Low at once
      await pv(`await p.seg("Video preview quality", "Low"); return true`);
      const lowOk = await waitFor(async () => qOf(await clipStem("video")) === "0" && (await pv(`return p.layers("video")?.playing`)), 10000, 100);
      const loFacts = clipFacts(await clipStem("video"));
      await pv(`await p.seg("Video preview quality", "Mid"); await p.order("Not hovered", ${JSON.stringify(NOT_HOVERED)}); return true`);
      if (!midFull) return [...v, `the video card never played its full Mid clip (${await clipStem("video")}) — proved nothing`];
      if (!capMid?.startsWith(`Mid · ${mid.fps} fps · ~`)) v.push(`Mid caption ${J(capMid)}, want "Mid · ${mid.fps} fps · ~… MB per wallpaper"`);
      if (!hiAsk) v.push(`after choosing High, no /clip request asked for q=high (${asks.length} asks)`);
      if (midAsk) v.push("after choosing High, a /clip request still asked for q=mid");
      if (tHigh == null) v.push(`no High clip played in the preview within 25 s (${await clipStem("video")})`);
      else if (tHigh > 3000) v.push(`a High clip played ${tHigh} ms after choosing High — want a sample within 3 s, not the full-length re-encode`);
      if (![...caps].includes("making the High preview…")) v.push(`the caption never said "making the High preview…" (${J([...caps])})`);
      if (!final) v.push(`the caption never settled on "High · ${hi.fps} fps · ~… MB per wallpaper" (last ${J(last)})`);
      else if (!last.includes(`${hi.fps} fps`)) v.push(`caption ${J(last)}: fps isn't the backend's ${hi.fps}`);
      if (!lowOk) v.push(`Low chosen after High: the preview never played a Low clip (it plays ${loFacts.stem})`);
      else if (hiFacts.error || loFacts.error) v.push(`couldn't read the served clips ${J([hiFacts, loFacts])}`);
      else {
        if (!(loFacts.fps < hiFacts.fps)) v.push(`Low's served clip runs ${loFacts.fps} fps, High's ${hiFacts.fps} (want Low below) ${J([loFacts, hiFacts])}`);
        if (!(loFacts.w < hiFacts.w || loFacts.bytes < hiFacts.bytes)) v.push(`Low's served clip isn't smaller than High's ${J([loFacts, hiFacts])}`);
      }
      return v;
    });

    await cell("cardpv:hover — hovering a preview card hands its clip to the real file and back", async () => {
      const v = [];
      if (!(await needCards(v, "hover"))) return v;
      await pv(`await p.order("Not hovered", ${JSON.stringify(ALWAYS)}); return true`);
      const clip = await waitFor(async () => { const l = await pv(`return p.layers("video")`); return l?.playing && l.src.includes("/clip?"); }, 15000, 200);
      await sleep(1000);
      const pt = await pv(`return p.box(p.card("video")?.querySelector(".thumb-wrap"))`);
      await move(pt.x, pt.y);
      const real = await waitFor(async () => (await pv(`return p.layers("video")?.src`))?.includes("/media?"), 6000, 100);
      await sleep(600); await shot("hover");
      await move(5, 5);
      const back = await waitFor(async () => (await pv(`return p.layers("video")?.src`))?.includes("/clip?"), 6000, 100);
      await pv(`await p.order("Not hovered", ${JSON.stringify(NOT_HOVERED)}); return true`);
      if (!clip) return [...v, "the clip never played before the hover — proved nothing"];
      if (!real) v.push(`hovered: the card never handed over to the real file (${await pv(`return p.layers("video")?.src`)})`);
      if (!back) v.push("unhovered: the clip never took back over");
      return v;
    });

    await cell("cardpv:noApply — clicks, right-clicks and keys on the preview apply nothing; the aria says it's a preview", async () => {
      const v = [];
      if (!(await needCards(v, "noApply"))) return v;
      const cur0 = (await http("GET", "/current")).json?.path ?? null;
      const pl0 = JSON.stringify((await http("GET", "/playlist/state")).json?.videoPaths ?? null);
      for (const kind of ["video", "both"]) {
        const b = await pv(`return p.box(p.card(${JSON.stringify(kind)})?.querySelector(".thumb-wrap"))`);
        if (!b) { v.push(`no ${kind} card`); continue; }
        const at = async (x, y, button, clickCount) => { await move(x, y); send({ type: "mouseDown", x, y, button, clickCount }); await sleep(40); send({ type: "mouseUp", x, y, button, clickCount }); await sleep(150); };
        await at(b.x, b.y, "left", 1);
        await at(b.x, b.y, "left", 2);
        await at(b.x, b.y, "right", 1);
        // where the playlist toggle (top right) and the trash (bottom right) sit
        await at(Math.round(b.r - 14), Math.round(b.t + 14), "left", 1);
        await at(Math.round(b.r - 20), Math.round(b.b - 66), "left", 1);
        for (const keyCode of ["Enter", "Space", "Delete"]) { send({ type: "keyDown", keyCode }); send({ type: "keyUp", keyCode }); await sleep(100); }
      }
      await move(5, 5); await sleep(1500);
      const cur1 = (await http("GET", "/current")).json?.path ?? null;
      const pl1 = JSON.stringify((await http("GET", "/playlist/state")).json?.videoPaths ?? null);
      const page = await js(`return document.querySelector(".app")?.dataset.page`);
      if (cur1 !== cur0) v.push(`what plays changed: ${cur0} → ${cur1}`);
      if (pl1 !== pl0) v.push(`the playlist changed: ${pl0} → ${pl1}`);
      if (page !== "settings") v.push(`the page changed to ${page}`);
      const a = await pv(`const f = p.frame(), c = document.querySelector("[data-card-preview] .card-pv-cards");
        return { group: f?.getAttribute("role"), label: f?.getAttribute("aria-label"), disabled: c?.getAttribute("aria-disabled"), cardsLabel: c?.getAttribute("aria-label") ?? "",
          buttons: [...c.querySelectorAll("button")].map((b) => b.inert && b.tabIndex === -1) }`);
      if (a.group !== "group" || !a.label) v.push(`the preview isn't a labelled group (${JSON.stringify(a)})`);
      if (a.disabled !== "true" || !/preview/i.test(a.cardsLabel) || !/nothing/i.test(a.cardsLabel)) v.push(`the cards don't say they're a preview that does nothing (aria ${JSON.stringify(a)})`);
      if (!a.buttons.length || a.buttons.some((x) => !x)) v.push(`the cards' own buttons are still clickable / tabbable (${JSON.stringify(a.buttons)})`);
      return v;
    });

    await cell("cardpv:offscreen — scrolled away nothing decodes or asks; window inactive nothing plays", async () => {
      const v = [];
      if (!(await needCards(v, "offscreen"))) return v;
      await pv(`await p.order("Not hovered", ${JSON.stringify(ALWAYS)}); return true`);
      const playing = await waitFor(async () => (await pv(`return p.layers("video")?.playing && p.layers("both")?.gif`)) === true, 15000, 200);
      await pv(`await p.toTop(); performance.clearResourceTimings(); return true`);
      await sleep(5000); // longer than a card's re-ask while a clip is being made
      const away = await pv(`return { cards: p.cards().length, media: document.querySelectorAll("[data-card-preview] video, [data-card-preview] img.thumb.anim").length, asks: p.clipAsks().length }`);
      await pv(`await p.toRows(); return true`);
      await waitFor(async () => (await pv(`return p.layers("video")?.playing`)) === true, 15000, 200);
      await js(`document.hasFocus = () => false; window.dispatchEvent(new Event("blur")); return true`);
      const idle = await waitFor(async () => { const r = await pv(`return [p.layers("video"), p.layers("both")]`); return r[0] && !r[0].video && !r[1].gif; }, 4000);
      const idleR = await pv(`return [p.layers("video"), p.layers("both")]`);
      await js(`delete document.hasFocus; window.dispatchEvent(new Event("focus")); return true`);
      await pv(`await p.order("Not hovered", ${JSON.stringify(NOT_HOVERED)}); return true`);
      if (!playing) return [...v, "the previews never played on screen — proved nothing"];
      if (away.cards || away.media) v.push(`scrolled away: ${away.cards} cards, ${away.media} media layers still mounted`);
      if (away.asks) v.push(`scrolled away: ${away.asks} clip requests in 5 s`);
      if (!idle) v.push(`window inactive: still playing ${JSON.stringify(idleR)}`);
      return v;
    });

    await cell("cardpv:motion — it fades in and a size change morphs; motion off: it fades in place, the size changes at once, and the cards stay whole, play and hover", async () => {
      const v = [], J = JSON.stringify;
      // per-frame samples of the frame's opacity while it comes in, and of the video slot's transform while the size changes
      const appear = () => pv(`await p.toTop(); const s = [], tf = []; let run = true;
        const tick = () => { if (!run) return; const f = p.frame(); if (f) { const c = getComputedStyle(f); s.push(+c.opacity); tf.push(c.transform); } requestAnimationFrame(tick); }; requestAnimationFrame(tick);
        document.querySelector(".pv-rows").scrollIntoView({ block: "center" }); await p.sleep(700); run = false; return { s, tf }`);
      const morph = (size) => pv(`const s = []; let run = true;
        const tick = () => { if (!run) return; const el = p.slot("video"); if (el) s.push(getComputedStyle(el).transform); requestAnimationFrame(tick); }; requestAnimationFrame(tick);
        await p.select("Card size", ${J(size)}); await p.sleep(600); run = false; return s`);
      // the preview as the user sees it: shown, every card whole (its box unscaled, on screen, the topmost thing at its
      // centre), the video card playing, and a hover handing its clip to the real file and back
      const whole = async (what) => {
        const out = [];
        await pv(`await p.order("Not hovered", ${JSON.stringify(ALWAYS)}); await p.toRows(); return true`);
        const ok = await waitFor(async () => { const r = await pv(`return { f: +getComputedStyle(p.frame()).opacity, n: p.cards().length, play: !!p.layers("video")?.playing }`); return r.f === 1 && r.n >= 2 && r.play; }, 15000, 200);
        const st = await pv(`return { f: +getComputedStyle(p.frame()).opacity, on: p.host().hasAttribute("data-on"), cards: p.cards().map((c) => { const b = c.getBoundingClientRect();
          const top = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
          return { w: Math.round(b.width), lw: c.offsetWidth, slot: c.parentElement.offsetWidth, on: b.top >= 0 && b.bottom <= innerHeight && b.width > 20, hit: !!top && c.contains(top) }; }), video: p.layers("video") }`);
        if (!ok) out.push(`${what}: not shown and playing within 15 s ${J(st)}`);
        for (const c of st.cards) {
          if (Math.abs(c.w - c.lw) > 1 || Math.abs(c.lw - c.slot) > 1) out.push(`${what}: a card is drawn ${c.w} px wide in a ${c.lw} px box (slot ${c.slot}) — scaled`);
          if (!c.on || !c.hit) out.push(`${what}: a card isn't visible on screen ${J(c)}`);
        }
        const pt = await pv(`return p.box(p.card("video")?.querySelector(".thumb-wrap"))`);
        if (pt) {
          await move(pt.x, pt.y);
          if (!(await waitFor(async () => (await pv(`return p.layers("video")?.src`))?.includes("/media?"), 6000, 100))) out.push(`${what}: hovered, the real file never took over`);
          await move(5, 5);
          if (!(await waitFor(async () => (await pv(`return p.layers("video")?.src`))?.includes("/clip?"), 6000, 100))) {
            // what the card holds then: every video (shown = .anim), whether it still counts as hovered, the preview's state
            const d = await pv(`const c = p.card("video"); const kind = (u) => !u ? null : u.includes("/media?") ? "real" : u.includes("/clip?") ? "clip" : u.slice(0, 40);
              return { hovered: c?.matches(":hover"), wrapHovered: c?.querySelector(".thumb-wrap")?.matches(":hover"), on: p.host()?.hasAttribute("data-on"),
                noMotion: document.documentElement.classList.contains("no-motion"), focus: document.hasFocus(),
                vids: c ? [...c.querySelectorAll("video")].map((v) => ({ cls: v.className, k: kind(v.getAttribute("src")), rs: v.readyState, p: v.paused, err: v.error?.code ?? null })) : null }`);
            out.push(`${what}: unhovered, the clip never came back ${J(d)}`);
          }
        }
        await pv(`await p.order("Not hovered", ${JSON.stringify(NOT_HOVERED)}); return true`);
        return out;
      };
      const unscaled = () => pv(`return [...document.querySelectorAll("[data-card-preview] .card-pv-slot")].map((s) => ({ t: getComputedStyle(s).transform,
        w: Math.round(s.getBoundingClientRect().width), lw: s.offsetWidth }))`);
      if (!(await needCards(v, "motion"))) return v;
      const mid = (s) => s.filter((o) => o > 0.05 && o < 0.95).length;
      const moved = (s) => s.filter((t) => t !== "none" && t !== "matrix(1, 0, 0, 1, 0, 0)").length;
      const { s: onA } = await appear(), onM = await morph("Large"); await morph("Medium");
      await pv(`await p.toRows(); await p.check("Smooth window animations", false); return true`);
      const { s: offA, tf: offT } = await appear(), offM = await morph("Large"); await morph("Medium");
      const tr = await pv(`const c = getComputedStyle(p.frame()); return { p: c.transitionProperty, d: c.transitionDuration }`);
      v.push(...(await whole("motion off")));
      await shot("motionoff");
      // turned off in the middle of a morph: motion on, a size change, motion off 80 ms into it
      await pv(`await p.toRows(); await p.check("Smooth window animations", true); return true`);
      await pv(`p.row("Card size")?.querySelector(".sel")?.click(); await p.sleep(250);
        [...document.querySelectorAll(".sel-pop .sel-opt")].find((e) => e.textContent.trim() === "Large")?.click(); await p.sleep(80);
        p.row("Smooth window animations").querySelector("input").click(); await p.sleep(900); return true`);
      const cut = await unscaled();
      v.push(...(await whole("motion turned off mid-morph")));
      await pv(`await p.select("Card size", "Medium"); return true`);
      // a fresh page with motion off
      await loadSettings();
      v.push(...(await whole("reloaded with motion off")));
      await pv(`await p.toRows(); await p.check("Smooth window animations", true); return true`);
      if (!onA.length || !mid(onA)) v.push(`motion on: no in-between opacity while it came in (${onA.length} frames, ${J(onA.slice(0, 12))})`);
      if (!moved(onM)) v.push(`motion on: the card didn't morph to its new size (${onM.length} frames, all at rest)`);
      if (!offA.length) v.push("motion off: no frames sampled — proved nothing");
      else if (!mid(offA)) v.push(`motion off: it popped in — no in-between opacity frame (want a fade) ${J(offA.slice(0, 12))}`);
      if (moved(offT)) v.push(`motion off: the frame moved while it came in (${moved(offT)} frames transformed: ${J(offT.find((t) => t !== "none"))})`);
      if (moved(offM)) v.push(`motion off: ${moved(offM)} frames of a size morph (want an instant change)`);
      // its transition: opacity (the fade) and the hover's colours only, the fade short
      const tp = tr.p.split(", "), td = tr.d.split(", ").map(parseFloat);
      if (tp.some((x) => /transform|translate|scale|rotate|all/.test(x)) || !tp.includes("opacity") || td[tp.indexOf("opacity") % td.length] > 0.15) v.push(`motion off: the frame's transition isn't a short fade (${J(tr)})`);
      if (cut.some((s) => (s.t !== "none" && s.t !== "matrix(1, 0, 0, 1, 0, 0)") || Math.abs(s.w - s.lw) > 1)) v.push(`motion turned off mid-morph: a card is left scaled ${J(cut)}`);
      return v;
    });

    await cell("cardpv:noGlow — Glow effects off takes the frame's hover glow; bg-live keeps a translucent card", async () => {
      const v = [];
      if (!(await needCards(v, "noGlow"))) return v;
      const accent = await js(`const d = document.createElement("i"); d.style.color = "var(--accent)"; document.body.append(d); const c = getComputedStyle(d).color; d.remove(); return c`);
      const hoverShadow = async () => {
        const b = await pv(`return p.box(document.querySelector("[data-card-preview] .card-pv-cap"))`);
        await move(b.x, b.y); await sleep(450);
        const s = await pv(`return getComputedStyle(p.frame()).boxShadow`); await move(5, 5); await sleep(250); return s;
      };
      const glow = await hoverShadow();
      await pv(`await p.toRows(); await p.check("Glow effects", false); await p.toRows(); return true`);
      const ng = await hoverShadow();
      await shot("noglow");
      await pv(`await p.toRows(); await p.check("Glow effects", true); await p.check("Wallpaper behind every tab", true); await p.toRows(); return true`);
      const bl = await pv(`return { live: document.documentElement.classList.contains("bg-live"), bg: getComputedStyle(p.frame()).backgroundColor, on: p.host().hasAttribute("data-on"), cards: p.cards().length }`);
      await pv(`await p.check("Wallpaper behind every tab", false); return true`);
      const rgb = accent.replace(/^rgba?\(|\)$/g, "").split(",").slice(0, 3).map((x) => x.trim()).join(", ");
      if (!glow.includes(rgb)) v.push(`glow on, hovered: the frame's shadow ${glow} has no accent glow (${accent}) — proved nothing`);
      if (ng.includes(rgb)) v.push(`glow off, hovered: the frame still glows (${ng})`);
      const a = /\/\s*([0-9.]+)\s*\)$/.exec(bl.bg)?.[1] ?? /rgba\([^)]*,\s*([0-9.]+)\)/.exec(bl.bg)?.[1] ?? 1;
      if (!bl.live) v.push("bg-live: the class never went on");
      if (!(+a < 1) || !(+a > 0)) v.push(`bg-live: the frame's fill ${bl.bg} (want a translucent card)`);
      if (!bl.on || bl.cards < 2) v.push(`bg-live: the preview went away (${JSON.stringify(bl)})`);
      return v;
    });

    await cell("cardpv:noOverflow — beside the rows at 1920 px (pinned while they scroll), above them at 960 px, never wider than the page", async () => {
      const v = [];
      for (const [w, h] of [[1920, 1080], [960, 900]]) {
        win.setContentSize(w, h); await sleep(800);
        if (!(await needCards(v, `${w}px`))) continue;
        await sleep(400);
        const r = await pv(`const sc = p.sc(), f = p.box(p.frame()), sec = p.box(p.host().parentElement.querySelector(":scope > .ssection")), s = sc.getBoundingClientRect();
          return { mode: p.host().dataset.cardPreview, f, sec, left: s.left, right: s.left + sc.clientWidth, scrollW: sc.scrollWidth, clientW: sc.clientWidth,
            docW: document.documentElement.scrollWidth, inner: innerWidth, cards: p.cards().map((c) => p.box(c)) }`);
        await shot(String(w));
        if (r.scrollW > r.clientW + 1) v.push(`${w}px: Settings scrolls sideways (${r.scrollW} > ${r.clientW})`);
        if (r.docW > r.inner + 1) v.push(`${w}px: the page is wider than the window (${r.docW} > ${r.inner})`);
        if (r.f.l < r.left - 0.5 || r.f.r > r.right + 0.5) v.push(`${w}px: the preview ${Math.round(r.f.l)}-${Math.round(r.f.r)} sticks out of the page ${Math.round(r.left)}-${Math.round(r.right)}`);
        for (const c of r.cards) if (c.l < r.f.l - 0.5 || c.r > r.f.r + 0.5) v.push(`${w}px: a card ${Math.round(c.l)}-${Math.round(c.r)} sticks out of the preview ${Math.round(r.f.l)}-${Math.round(r.f.r)}`);
        if (w === 1920) {
          if (r.mode !== "side") v.push(`1920px: placed ${r.mode}, want beside the rows`);
          else if (r.f.l < r.sec.r) v.push(`1920px: the preview (from ${Math.round(r.f.l)}) overlaps the section (to ${Math.round(r.sec.r)})`);
          // scrolled until the section's top is well above the window: the preview stays pinned at the top
          const pin = await pv(`const sc = p.sc(), sec = p.host().parentElement.querySelector(":scope > .ssection");
            sc.scrollTop += sec.getBoundingClientRect().top - sc.getBoundingClientRect().top + 160; await p.sleep(400);
            return { f: p.box(p.frame()).t, sc: sc.getBoundingClientRect().top, sec: sec.getBoundingClientRect().top, cards: p.cards().length }`);
          if (pin.sec > pin.sc - 100) v.push(`1920px: couldn't scroll the section's top away (${JSON.stringify(pin)}) — proved nothing`);
          else if (Math.abs(pin.f - pin.sc) > 30 || !pin.cards) v.push(`1920px: scrolled 160 px into the section, the preview isn't pinned at the top (frame ${Math.round(pin.f)}, page top ${Math.round(pin.sc)}, ${pin.cards} cards)`);
        } else {
          if (r.mode !== "above") v.push(`960px: placed ${r.mode}, want above the rows`);
          else if (r.f.b > r.sec.t + 0.5) v.push(`960px: the preview (to ${Math.round(r.f.b)}) overlaps the section (from ${Math.round(r.sec.t)})`);
        }
      }
      win.setContentSize(1400, 900); await sleep(400);
      return v;
    });
  } catch (e) {
    results.push({ name: "setup", v: [e.message] });
    console.log(`ERROR setup: ${e.message}`);
  }
  const fail = results.filter((r) => r.v.length).length;
  console.log(`CARDPV pass=${results.length - fail} fail=${fail}`);
  fs.writeFileSync(path.join(OUT, "cardpreview.json"), JSON.stringify(results, null, 1));
  app.exit(fail ? 1 : 0);
});
