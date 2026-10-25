// Settings-modal morph probe — `scripts/test-ui-matrix.sh --probe probe-morph.js` (same hermetic stack as
// the matrix: private backend + headless lp-player + this tree's UI bundle, on a private Xvfb). Opens the
// per-item settings modal from a library card and from a playlist-strip item and samples the modal media's
// on-screen box every frame through the open and the close (its transform AND its clip-path crop):
//   - it starts and ends ON the source's visible thumbnail (the card / strip crop), whatever the aspects
//   - one uniform scale all the way: the picture never stretches (its aspect stays the image's own)
//   - smooth (no frame jumps a large share of the distance), it lands and stays
//   - the close lands on the source — from the strip too (it used to just vanish)
//   - an animated preview keeps animating inside the modal (gif → the same /anim image; a video item →
//     its video playing) — it used to freeze on a still
// k1 = a square preview + gif (like a Wallpaper Engine item; the harness writes them), k2 = video only.
// Screenshots of an open + close: <LP_OUT>/morph-<surface>-<n>.png. Exit 1 on any FAIL.
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

const E = process.env;
const U = E.LP_URL;
const K = JSON.parse(E.LP_CLIPS);
const OUT = E.LP_OUT;
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
  strip(t) { return [...document.querySelectorAll(".pl-item")].find((e) => e.title === t); },
  source(surface, t) { return surface === "lib" ? this.card(t)?.querySelector(".thumb-wrap") : this.strip(t); },
  rect(el) { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; },
  ctx(el) { const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.x + 10, clientY: r.y + 10 })); },
  media() { return document.querySelector(".lib-settings [data-morph-media]") || document.querySelector(".lib-settings .lib-stage img"); },
  // the media's visible box: its transformed border box minus its clip-path inset (scaled by the
  // transform's scale — transform-origin 0 0 or not, the inset scales with the box)
  vis(el) {
    const b = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    let t = 0, r = 0, bo = 0, l = 0;
    const m = /inset\\(([^)]*)\\)/.exec(cs.clipPath || "");
    if (m) { const v = m[1].split(" round ")[0].trim().split(/\\s+/).map(parseFloat);
      [t, r, bo, l] = v.length === 1 ? [v[0], v[0], v[0], v[0]] : v.length === 2 ? [v[0], v[1], v[0], v[1]] : v.length === 3 ? [v[0], v[1], v[2], v[1]] : v; }
    const k = el.offsetWidth ? b.width / el.offsetWidth : 1;
    return { box: { x: b.x, y: b.y, w: b.width, h: b.height }, vis: { x: b.x + l * k, y: b.y + t * k, w: b.width - (l + r) * k, h: b.height - (t + bo) * k } };
  },
  sample(ms, trigger) {
    return new Promise((res) => {
      const out = []; const t0 = performance.now();
      const f = () => {
        const el = this.media();
        out.push({ t: performance.now() - t0, open: !!document.querySelector(".lib-settings"), ...(el ? this.vis(el) : {}) });
        if (performance.now() - t0 < ms) requestAnimationFrame(f); else res(out);
      };
      if (trigger) trigger();
      requestAnimationFrame(f);
    });
  },
  async open(surface, t, ms) {
    const src = this.source(surface, t); if (!src) throw new Error("no source " + surface + " " + t);
    const S = this.rect(src);
    this.ctx(src); await this.sleep(250);
    const btn = this.byText(surface === "lib" ? ".lib-ctx button" : ".pl-ctx button", "Settings (volume / speed)");
    if (!btn) throw new Error("no Settings menu item");
    const samples = await this.sample(ms, () => btn.click());
    return { S, samples };
  },
  async close(surface, t, ms) {
    const btn = this.byText(".lib-settings .modal-actions button", "Close"); if (!btn) throw new Error("no Close button");
    const S = this.rect(this.source(surface, t));
    const samples = await this.sample(ms, () => btn.click());
    return { S, samples, srcVisible: getComputedStyle(this.source(surface, t)).visibility !== "hidden" && +getComputedStyle(this.source(surface, t)).opacity > 0.5 };
  },
  // what the modal animates with (a canvas drawImage of an animated <img> always gives the same frame,
  // so a gif is checked from two screen captures on the probe side)
  async animating() {
    const img = [...document.querySelectorAll(".lib-settings img")].find((i) => /\\/anim\\?/.test(i.src) && i.complete && i.naturalWidth);
    const vid = [...document.querySelectorAll(".lib-settings video")][0];
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
  const travel = Math.hypot(x1 - x0, y1 - y0) + Math.abs(w1 - w0);
  let maxStep = 0, moving = 0;
  for (let i = 1; i < live.length; i++) {
    const [a, b, w] = c(live[i - 1]), [p, q, z] = c(live[i]);
    const step = Math.hypot(p - a, q - b) + Math.abs(z - w);
    if (step > 0.5) moving++;
    maxStep = Math.max(maxStep, step);
  }
  if (travel > 40 && moving < 5) v.push(`${what}: only ${moving} moving frames over ${travel.toFixed(0)} px — a jump, not a morph`);
  if (travel > 40 && maxStep > 0.45 * travel) v.push(`${what}: one frame jumped ${maxStep.toFixed(0)} px of ${travel.toFixed(0)}`);
  return v;
}

async function shots(surface, t) {
  // a separate open/close with screenshots for review (capturePage stalls frames: no checks here)
  const files = [];
  const grab = async (tag) => { const img = await win.webContents.capturePage(); const f = path.join(OUT, `morph-${surface}-${tag}.png`); fs.writeFileSync(f, img.toPNG()); files.push(f); };
  await page(`const src = m.source(${JSON.stringify(surface)}, ${JSON.stringify(t)}); m.ctx(src); await m.sleep(250);
    m.byText(${JSON.stringify(surface === "lib" ? ".lib-ctx button" : ".pl-ctx button")}, "Settings (volume / speed)").click();`);
  for (let i = 0; i < 6; i++) { await grab(`open${i}`); await sleep(40); }
  await sleep(500); await grab("open-done");
  await page(`m.byText(".lib-settings .modal-actions button", "Close").click();`);
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
    for (const surface of ["lib", "pl"]) for (const [t, aspect] of [["k1", 1], ["k2", 16 / 9]]) {
      let M = null;
      await cell(`${surface} ${t} open`, async () => {
        const { S, samples } = await page(`return await m.open(${JSON.stringify(surface)}, ${JSON.stringify(t)}, 900);`);
        const live = samples.filter((s) => s.vis && s.vis.w > 1);
        M = live.length ? live[live.length - 1].vis : null;
        const v = flight(samples, S, null, aspect, "open");
        const tail = live.slice(-4);
        if (tail.length === 4 && !tail.every((s) => edgesNear(s.vis, tail[0].vis, 0.5))) v.push(`open: still moving 900 ms after the click (${fmt(tail[0].vis)} → ${fmt(tail[3].vis)})`);
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
        const { S, samples, srcVisible } = await page(`return await m.close(${JSON.stringify(surface)}, ${JSON.stringify(t)}, 1100);`);
        const v = flight(samples, M, S, aspect, "close");
        const goneAt = samples.find((s) => !s.open)?.t;
        if (goneAt == null) v.push("close: the modal is still open 1.1 s after Close");
        if (!srcVisible) v.push("close: the source thumbnail is still hidden after the close");
        return v;
      });
      await sleep(400);
    }
    const files = [...await shots("lib", "k1"), ...await shots("pl", "k1")];
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
