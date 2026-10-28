// Settings-modal morph probe — `scripts/test-ui-matrix.sh --probe probe-morph.js` (same hermetic stack as
// the matrix: private backend + headless liascape-player + this tree's UI bundle, on a private Xvfb). Opens the
// per-card settings modal from a library card and from a playlist-bar item and samples the modal media's
// on-screen box every frame through the open and the close (its transform AND its clip-path crop):
//   - it starts and ends ON the source's visible thumbnail (the card / playlistBar crop), whatever the aspects
//   - one uniform scale all the way: the picture never stretches (its aspect stays the image's own)
//   - smooth (no frame jumps a large share of the distance), it lands and stays
//   - the close lands on the source — from the playlist bar too (it used to just vanish)
//   - an animated preview keeps animating inside the modal (gif → the same /anim image; a video item →
//     its video playing) — it used to freeze on a still
// k1 = a square preview + gif (like a Wallpaper Engine item; the harness writes them), k2 = video only.
// Screenshots of an open + close: <LIASCAPE_OUT>/morph-<surface>-<n>.png. Exit 1 on any FAIL.
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

const E = process.env;
const U = E.LIASCAPE_URL;
const K = JSON.parse(E.LIASCAPE_CLIPS);
const OUT = E.LIASCAPE_OUT;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.setPath("userData", path.join(OUT, "electron-user-data"));

async function http(method, p, body) {
  const r = await fetch(U + p, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null; try { json = await r.json(); } catch { /* empty */ }
  return { status: r.status, json };
}
const post = (p, b = {}) => http("POST", p, b);

let win;
const js = (code) => win.webContents.executeJavaScript(code);
const PAGE = `window.__mo = {
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  byText(sel, text) { return [...document.querySelectorAll(sel)].find((e) => e.textContent.trim() === text); },
  card(t) { return [...document.querySelectorAll(".card.lib")].find((c) => c.querySelector(".lib-title")?.title === t); },
  playlistBar(t) { return [...document.querySelectorAll(".pl-item")].find((e) => e.title === t); },
  source(surface, t) { return surface === "pl" ? this.playlistBar(t) : this.card(t)?.querySelector(".thumb-wrap"); }, // lib + br: a .card.lib
  rect(el) { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; },
  ctx(el) { const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.x + 10, clientY: r.y + 10 })); },
  modal() { return document.querySelector(".modal-backdrop .modal"); },
  media() { return document.querySelector(".modal-backdrop [data-morph-media]") || document.querySelector(".modal-backdrop .modal img"); },
  // box = the whole picture on screen ([data-morph-pic], counter-scaled inside the media box), vis = what
  // shows of it: the media box (it clips) minus a clip-path inset if it has one (the old re-crop — scaled by
  // the transform's scale, transform-origin 0 0 or not, the inset scales with the box)
  vis(el) {
    const pic = el.querySelector("[data-morph-pic]");
    const pb = pic ? pic.getBoundingClientRect() : null;
    const b = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    let t = 0, r = 0, bo = 0, l = 0;
    const m = /inset\\(([^)]*)\\)/.exec(cs.clipPath || "");
    if (m) { const v = m[1].split(" round ")[0].trim().split(/\\s+/).map(parseFloat);
      [t, r, bo, l] = v.length === 1 ? [v[0], v[0], v[0], v[0]] : v.length === 2 ? [v[0], v[1], v[0], v[1]] : v.length === 3 ? [v[0], v[1], v[2], v[1]] : v; }
    const k = el.offsetWidth ? b.width / el.offsetWidth : 1;
    const box = pb ? { x: pb.x, y: pb.y, w: pb.width, h: pb.height } : { x: b.x, y: b.y, w: b.width, h: b.height };
    return { box, vis: { x: b.x + l * k, y: b.y + t * k, w: b.width - (l + r) * k, h: b.height - (t + bo) * k } };
  },
  sample(ms, trigger) {
    return new Promise((res) => {
      const out = []; const t0 = performance.now();
      const f = () => {
        const el = this.media(), md = this.modal();
        const shown = md && getComputedStyle(md).visibility !== "hidden"; // hidden = still waiting to fly
        out.push({ t: performance.now() - t0, open: !!md, ...(el && shown ? this.vis(el) : {}) });
        if (performance.now() - t0 < ms) requestAnimationFrame(f); else res(out);
      };
      if (trigger) trigger();
      requestAnimationFrame(f);
    });
  },
  async open(surface, t, ms) {
    const src = this.source(surface, t); if (!src) throw new Error("no source " + surface + " " + t);
    const S = this.rect(src);
    // Browse: right-click opens the preview itself; library / playlistBar: their menu's Settings item
    let btn = null;
    if (surface !== "br") {
      this.ctx(src); await this.sleep(250);
      btn = this.byText(surface === "lib" ? ".lib-ctx button" : ".pl-ctx button", "Settings (volume / speed)");
      if (!btn) throw new Error("no Settings menu item");
    }
    const samples = await this.sample(ms, () => (btn ? btn.click() : this.ctx(src)));
    return { S, samples };
  },
  async close(surface, t, ms) {
    const btn = this.byText(".modal-backdrop .modal-actions button", "Close"); if (!btn) throw new Error("no Close button");
    const S = this.rect(this.source(surface, t));
    const samples = await this.sample(ms, () => btn.click());
    return { S, samples, srcVisible: getComputedStyle(this.source(surface, t)).visibility !== "hidden" && +getComputedStyle(this.source(surface, t)).opacity > 0.5 };
  },
  // what the modal animates with (a canvas drawImage of an animated <img> always gives the same frame,
  // so a gif is checked from two screen captures on the probe side)
  async animating() {
    const img = [...document.querySelectorAll(".modal-backdrop .modal img")].find((i) => /\\/anim\\?/.test(i.src) && i.complete && i.naturalWidth);
    const vid = [...document.querySelectorAll(".modal-backdrop .modal video")][0];
    if (img) { const b = img.getBoundingClientRect(); return { kind: "gif", rect: { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) } }; }
    if (vid) { const a = vid.currentTime; await this.sleep(600); return { kind: "video", ok: !vid.paused && vid.currentTime > a, t: [a, vid.currentTime] }; }
    return { kind: "none", ok: false };
  },
}; true`;
const page = (code) => js(`(async () => { const m = window.__mo; ${code} })()`);

const near = (a, b, px) => Math.abs(a - b) <= px;
const edgesNear = (r, S, px) => near(r.x, S.x, px) && near(r.y, S.y, px) && near(r.x + r.w, S.x + S.w, px) && near(r.y + r.h, S.y + S.h, px);
const fmt = (r) => r ? `${r.x.toFixed(0)},${r.y.toFixed(0)} ${r.w.toFixed(0)}×${r.h.toFixed(0)}` : "—";

// the checks on one sampled flight: from → to, uniform aspect, smooth
function flight(samples, from, to, aspect, what) {
  const v = [];
  const live = samples.filter((s) => s.vis && s.vis.w > 1);
  if (live.length < 4) return [`${what}: only ${live.length} frames with the media on screen`];
  const first = live[0], last = live[live.length - 1];
  if (from && !edgesNear(first.vis, from, 6)) v.push(`${what}: first frame shows ${fmt(first.vis)}, the source is ${fmt(from)}`);
  if (to && !edgesNear(last.vis, to, 6)) v.push(`${what}: last frame shows ${fmt(last.vis)}, expected ${fmt(to)}`);
  const bad = live.filter((s) => Math.abs(s.box.w / s.box.h - aspect) / aspect > 0.025);
  if (bad.length) v.push(`${what}: the picture is stretched in ${bad.length}/${live.length} frames (box ${fmt(bad[0].box)}, aspect ${(bad[0].box.w / bad[0].box.h).toFixed(3)} vs the image's ${aspect.toFixed(3)})`);
  const c = (s) => [s.vis.x + s.vis.w / 2, s.vis.y + s.vis.h / 2, s.vis.w];
  const [x0, y0, w0] = c(first), [x1, y1, w1] = c(last);
  // the scale of the flight: first → last, or the furthest it got (a round trip ends where it began)
  let travel = Math.hypot(x1 - x0, y1 - y0) + Math.abs(w1 - w0);
  let maxStep = 0, moving = 0;
  for (let i = 1; i < live.length; i++) {
    const [a, b, w] = c(live[i - 1]), [p, q, z] = c(live[i]);
    const step = Math.hypot(p - a, q - b) + Math.abs(z - w);
    if (step > 0.5) moving++;
    maxStep = Math.max(maxStep, step);
    travel = Math.max(travel, Math.hypot(p - x0, q - y0) + Math.abs(z - w0));
  }
  if (travel > 40 && moving < 5) v.push(`${what}: only ${moving} moving frames over ${travel.toFixed(0)} px — a jump, not a morph`);
  if (travel > 40 && maxStep > 0.45 * travel) v.push(`${what}: one frame jumped ${maxStep.toFixed(0)} px of ${travel.toFixed(0)}`);
  return v;
}

// how long the picture moved: the first frame off the start pose → the first frame of the end pose it stays in
function movingMs(samples) {
  const live = samples.filter((s) => s.vis && s.vis.w > 1);
  if (live.length < 2) return 0;
  const start = live[0].vis, end = live[live.length - 1].vis;
  const a = live.find((s) => !edgesNear(s.vis, start, 0.5));
  const bi = live.findIndex((s, i) => i > 0 && live.slice(i).every((x) => edgesNear(x.vis, end, 0.5)));
  return a && bi > 0 ? live[bi].t - a.t : 0;
}
// the moving window [first frame off the start pose, first frame of the end pose] (sample indices)
function movingWindow(samples) {
  const live = samples.filter((s) => s.vis && s.vis.w > 1);
  if (live.length < 2) return null;
  const start = live[0].vis, end = live[live.length - 1].vis;
  const a = live.findIndex((s) => !edgesNear(s.vis, start, 0.5));
  const b = live.findIndex((s, i) => i > 0 && live.slice(i).every((x) => edgesNear(x.vis, end, 0.5)));
  return a >= 0 && b > a ? { live, a, b } : null;
}
// how far the picture's centre + width got (0 → 1) at `frac` of the moving time — a front-loaded curve
// (the old open did ~70 % in its first quarter) reads as a snap however long the flight is
function progressAt(samples, frac) {
  const w = movingWindow(samples); if (!w) return null;
  const c = (s) => [s.vis.x + s.vis.w / 2, s.vis.y + s.vis.h / 2, s.vis.w];
  const [x0, y0, w0] = c(w.live[w.a - 1] ?? w.live[0]), [x1, y1, w1] = c(w.live[w.b]);
  const total = Math.hypot(x1 - x0, y1 - y0) + Math.abs(w1 - w0);
  const t = w.live[w.a].t + frac * (w.live[w.b].t - w.live[w.a].t);
  const s = w.live.find((x) => x.t >= t); if (!s || total < 40) return null;
  const [x, y, z] = c(s);
  return (Math.hypot(x - x0, y - y0) + Math.abs(z - w0)) / total;
}
// frame pacing through the moving window vs the page's idle frame interval (rAF deltas — the sampler's
// own per-frame reads included, so a bound, not a benchmark): median within 25 % of idle, ≤ 15 % of the
// frames late by more than one idle interval
function pacing(samples, idle, what) {
  const w = movingWindow(samples); if (!w) return [];
  const d = []; for (let i = w.a + 1; i <= w.b; i++) d.push(w.live[i].t - w.live[i - 1].t);
  if (d.length < 5) return [];
  const sorted = [...d].sort((x, y) => x - y), med = sorted[Math.floor(sorted.length / 2)];
  const late = d.filter((x) => x > 2 * idle).length;
  const v = [];
  if (med > 1.25 * idle) v.push(`${what}: median frame ${med.toFixed(1)} ms vs ${idle.toFixed(1)} ms idle`);
  if (late > 0.15 * d.length) v.push(`${what}: ${late}/${d.length} frames over ${(2 * idle).toFixed(0)} ms (max ${sorted[sorted.length - 1].toFixed(0)})`);
  return v;
}
// the settings modal's morph runs slow + soft on purpose (owner: "slow down morph" — 430 ms read as a snap,
// 620 ms "still too snappy"; morph.ts SETTINGS_MORPH = 900 / 700 ms, a symmetric ease-in-out); the Browse
// preview keeps its own pace (another modal, not asked for)
const SLOW_OPEN_MS = 620, SLOW_OPEN_MAX = 840, SLOW_CLOSE_MS = 470, SLOW_CLOSE_MAX = 680, BR_MAX_MS = 520, QUARTER_MAX = 0.3;
let IDLE_FRAME = 16.7;

async function shots(surface, t) {
  // a separate open/close with screenshots for review (capturePage stalls frames: no checks here)
  const files = [];
  const grab = async (tag) => { const img = await win.webContents.capturePage(); const f = path.join(OUT, `morph-${surface}-${tag}.png`); fs.writeFileSync(f, img.toPNG()); files.push(f); };
  await page(`const src = m.source(${JSON.stringify(surface)}, ${JSON.stringify(t)}); m.ctx(src);
    if (${JSON.stringify(surface)} !== "br") { await m.sleep(250); m.byText(${JSON.stringify(surface === "lib" ? ".lib-ctx button" : ".pl-ctx button")}, "Settings (volume / speed)").click(); }`);
  for (let i = 0; i < 6; i++) { await grab(`open${i}`); await sleep(40); }
  await sleep(500); await grab("open-done");
  await page(`m.byText(".modal-backdrop .modal-actions button", "Close").click();`);
  for (let i = 0; i < 6; i++) { await grab(`close${i}`); await sleep(40); }
  await sleep(600); await grab("close-done");
  return files;
}

app.whenReady().then(async () => {
  win = new BrowserWindow({ show: true, width: 1400, height: 900, webPreferences: { backgroundThrottling: false } });
  const results = [];
  const cell = async (name, fn) => {
    let v;
    try { v = await fn(); } catch (e) { v = [`ERROR ${e.message}`]; }
    results.push({ name, v });
    console.log(`${v.length ? "FAIL" : "PASS"}  ${name}`);
    for (const x of v) console.log(`        - ${x}`);
  };
  try {
    await post("/playlist/state", { videoPaths: [K[0], K[1], K[2]], settings: null, name: null });
    const lib = (await http("GET", "/library")).json;
    const k1 = lib.find((i) => i.videoPath === K[0]);
    if (!k1?.animatedThumbnailPath) throw new Error(`setup: k1 has no animated thumbnail (${JSON.stringify(k1?.animatedThumbnailPath)})`);
    await win.loadURL(U + "/");
    for (let i = 0; i < 100; i++) { if (await js(`document.querySelectorAll('.card.lib').length`) >= 4 && await js(`document.querySelectorAll('.pl-item').length`) >= 3) break; await sleep(100); }
    await js(PAGE); await sleep(800);
    IDLE_FRAME = await js(`new Promise((res) => { const d = []; let l = null; const f = (t) => { if (l != null) d.push(t - l); l = t; if (d.length < 40) requestAnimationFrame(f); else { d.sort((a, b) => a - b); res(d[20]); } }; requestAnimationFrame(f); })`);
    console.log(`idle frame ${IDLE_FRAME.toFixed(1)} ms`);
    for (const surface of ["lib", "pl"]) for (const [t, aspect] of [["k1", 1], ["k2", 16 / 9]]) {
      let M = null;
      await cell(`${surface} ${t} open`, async () => {
        const { S, samples } = await page(`return await m.open(${JSON.stringify(surface)}, ${JSON.stringify(t)}, 1300);`);
        const live = samples.filter((s) => s.vis && s.vis.w > 1);
        M = live.length ? live[live.length - 1].vis : null;
        const v = flight(samples, S, null, aspect, "open");
        const tail = live.slice(-4);
        if (tail.length === 4 && !tail.every((s) => edgesNear(s.vis, tail[0].vis, 0.5))) v.push(`open: still moving 1300 ms after the click (${fmt(tail[0].vis)} → ${fmt(tail[3].vis)})`);
        const ms = movingMs(samples);
        if (ms < SLOW_OPEN_MS || ms > SLOW_OPEN_MAX) v.push(`open: the flight took ${ms.toFixed(0)} ms (want ${SLOW_OPEN_MS}–${SLOW_OPEN_MAX} — slowed on purpose)`);
        const q = progressAt(samples, 0.25);
        if (q != null && q > QUARTER_MAX) v.push(`open: ${(q * 100).toFixed(0)} % of the travel in the first quarter of the flight (want ≤ ${QUARTER_MAX * 100} — front-loaded)`);
        v.push(...pacing(samples, IDLE_FRAME, "open"));
        console.log(`        open ${ms.toFixed(0)} ms, quarter ${q == null ? "—" : (q * 100).toFixed(0) + " %"}`);
        return v;
      });
      await cell(`${surface} ${t} animates in the modal`, async () => {
        await sleep(300);
        const a = await page(`return await m.animating();`);
        if (a.kind === "gif") {
          const one = (await win.webContents.capturePage(a.rect)).toBitmap();
          await sleep(500);
          const two = (await win.webContents.capturePage(a.rect)).toBitmap();
          a.ok = one.length > 0 && !one.equals(two);
        }
        return a.ok ? [] : [`the modal's preview is not animating (${a.kind}${a.t ? ` ${a.t.map((x) => x.toFixed(2)).join(" → ")}` : ""})`];
      });
      await cell(`${surface} ${t} close`, async () => {
        const { S, samples, srcVisible } = await page(`return await m.close(${JSON.stringify(surface)}, ${JSON.stringify(t)}, 1400);`);
        const v = flight(samples, M, S, aspect, "close");
        const goneAt = samples.find((s) => !s.open)?.t;
        if (goneAt == null) v.push("close: the modal is still open 1.4 s after Close");
        const ms = movingMs(samples.filter((s) => s.open));
        if (ms < SLOW_CLOSE_MS || ms > SLOW_CLOSE_MAX) v.push(`close: the flight took ${ms.toFixed(0)} ms (want ${SLOW_CLOSE_MS}–${SLOW_CLOSE_MAX})`);
        const q = progressAt(samples.filter((s) => s.open), 0.25);
        if (q != null && q > QUARTER_MAX) v.push(`close: ${(q * 100).toFixed(0)} % of the travel in the first quarter of the flight (want ≤ ${QUARTER_MAX * 100})`);
        v.push(...pacing(samples.filter((s) => s.open), IDLE_FRAME, "close"));
        console.log(`        close ${ms.toFixed(0)} ms, quarter ${q == null ? "—" : (q * 100).toFixed(0) + " %"}`);
        if (!srcVisible) v.push("close: the source thumbnail is still hidden after the close");
        return v;
      });
      await sleep(400);
    }
    // closed while still flying open (a quick Escape): it turns around where it is — no jump to the end
    // pose and back — and lands on the source
    await cell("lib k1 close mid-open", async () => {
      const r = await page(`const src = m.source("lib", "k1"); const S = m.rect(src); m.ctx(src); await m.sleep(250);
        const btn = m.byText(".lib-ctx button", "Settings (volume / speed)");
        const samples = await m.sample(1200, () => { btn.click(); setTimeout(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), 120); });
        return { S, samples, srcVisible: getComputedStyle(src).visibility !== "hidden" };`);
      const v = flight(r.samples.filter((s) => s.open), r.S, r.S, 1, "open+close");
      if (r.samples[r.samples.length - 1].open) v.push("still open 1200 ms after an Escape at 120 ms");
      if (!r.srcVisible) v.push("the source is still hidden");
      return v;
    });
    // Browse: the preview / more-info modal, from a local Wallpaper Engine item (square preview + gif)
    const we = path.join(path.dirname(path.dirname(path.dirname(path.dirname(K[0])))), "we-workshop", "9001");
    fs.mkdirSync(we, { recursive: true });
    const ff = (args) => require("child_process").execFileSync("ffmpeg", ["-nostdin", "-loglevel", "error", "-y", ...args], { timeout: 60000 });
    ff(["-f", "lavfi", "-i", "smptebars=size=480x480", "-frames:v", "1", path.join(we, "preview.jpg")]);
    ff(["-f", "lavfi", "-i", "testsrc2=size=240x240:rate=12:duration=2", "-vf", "split[a][b];[a]palettegen[p];[b][p]paletteuse", path.join(we, "preview.gif")]);
    ff(["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(we, "we1.mp4")]);
    fs.writeFileSync(path.join(we, "project.json"), JSON.stringify({ title: "we1", type: "video", file: "we1.mp4", preview: "preview.jpg" }));
    const s0 = (await http("GET", "/settings")).json;
    await post("/settings", { ...s0, workshopFolder: path.dirname(we), autoAddWeWallpapersToLibrary: false });
    const srcs = (await http("GET", "/sources")).json;
    const weName = (srcs.find?.((x) => x.index === 3) ?? srcs[3])?.name;
    await page(`m.byText(".tab", "Browse").click(); await m.sleep(500); m.byText(".pill", ${JSON.stringify(weName)}).click();`);
    for (let i = 0; i < 80; i++) { if (await page(`return !!m.card("we1");`)) break; await sleep(150); }
    // you right-click a card you can see: wait for its picture (the still, or the gif over a lazy still)
    let shown = false;
    for (let i = 0; i < 50 && !shown; i++) { shown = await page(`return [...m.card("we1").querySelectorAll(".thumb-wrap img.thumb")].some((i) => i.naturalWidth > 0);`); if (!shown) await sleep(100); }
    if (!shown) await cell("br we1 card shows a picture", async () => ["the Browse card loaded no picture within 5 s"]);
    await sleep(300);
    let BM = null;
    await cell("br we1 open", async () => {
      const { S, samples } = await page(`return await m.open("br", "we1", 900);`);
      const live = samples.filter((x) => x.vis && x.vis.w > 1);
      BM = live.length ? live[live.length - 1].vis : null;
      const v = flight(samples, S, null, 1, "open");
      const ms = movingMs(samples);
      if (ms > BR_MAX_MS) v.push(`open: the Browse preview's flight took ${ms.toFixed(0)} ms — it keeps its own pace (≤ ${BR_MAX_MS})`);
      v.push(...pacing(samples, IDLE_FRAME, "open"));
      return v;
    });
    await cell("br we1 animates in the modal", async () => {
      await sleep(300);
      const a = await page(`return await m.animating();`);
      if (a.kind === "gif") {
        const one = (await win.webContents.capturePage(a.rect)).toBitmap(); await sleep(500);
        a.ok = one.length > 0 && !one.equals((await win.webContents.capturePage(a.rect)).toBitmap());
      }
      return a.ok ? [] : [`the preview is not animating (${a.kind})`];
    });
    await cell("br we1 close", async () => {
      const { S, samples, srcVisible } = await page(`return await m.close("br", "we1", 1100);`);
      const v = flight(samples, BM, S, 1, "close");
      if (samples.find((x) => !x.open) == null) v.push("close: still open 1.1 s after Close");
      v.push(...pacing(samples.filter((x) => x.open), IDLE_FRAME, "close"));
      if (!srcVisible) v.push("close: the card is still hidden after the close");
      return v;
    });
    const brShots = await shots("br", "we1");
    await page(`m.byText(".tab", "Library").click();`); await sleep(800);
    const files = [...await shots("lib", "k1"), ...await shots("pl", "k1"), ...brShots];
    console.log(`screenshots: ${files.length} in ${OUT}`);
  } catch (e) {
    results.push({ name: "setup", v: [e.message] });
    console.log(`ERROR setup: ${e.message}`);
  }
  const fail = results.filter((r) => r.v.length).length;
  console.log(`MORPH pass=${results.length - fail} fail=${fail}`);
  fs.writeFileSync(path.join(OUT, "morph.json"), JSON.stringify(results, null, 1));
  app.exit(fail ? 1 : 0);
});
