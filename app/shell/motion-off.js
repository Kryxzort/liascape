// Motion-off checks shared by the probes. With "Smooth window animations" off or prefers-reduced-motion (:root.no-motion,
// useMotion() false) nothing moves and what appears, leaves or swaps fades in place on opacity alone, briefly
// (docs/decisions.md § "Fade, never move, with motion off"; app/ui/src/components/motion.ts FADE_MS, index.css --fade-dur).
//   SAMPLE(sels, ms)  in-page source of an expression: a Promise of { <name>: [[t, op, x, y, w, h] | [t, null], …] }, one
//                     entry per frame for `ms`, for each selector's first rendered match — `op` its opacity as seen (the product up
//                     the tree), the box as drawn (transforms included); null = absent or not rendered
//   judge(name, frames, opts)  what's wrong with one element's frames: it moved or resized while shown (`still`, default on;
//                     `size: false` lets the height / width follow content), it popped in (`appear`: no in-between opacity
//                     frame before full) or out (`leave`: none between its last full frame and gone), a fade longer than
//                     `maxMs`; an appear / leave that never happened in the sample "proved nothing"
//   OPACITY_ONLY      in-page source of a function (el) => the properties its running animations (subtree) animate other
//                     than opacity — [] when it only fades
const FADE_MS = 120;
const SAMPLE = (sels, ms = 900) => `(() => new Promise((res) => { const S = ${JSON.stringify(sels)}, out = {}; for (const k in S) out[k] = [];
  const t0 = performance.now();
  const f = () => { const t = Math.round(performance.now() - t0);
    for (const k in S) { const e = [...document.querySelectorAll(S[k])].find((x) => x.getClientRects().length);
      if (!e) { out[k].push([t, null]); continue; }
      let op = 1; for (let x = e; x && x.nodeType === 1; x = x.parentElement) op *= +getComputedStyle(x).opacity;
      const r = e.getBoundingClientRect(); out[k].push([t, +op.toFixed(3), +r.x.toFixed(1), +r.y.toFixed(1), +r.width.toFixed(1), +r.height.toFixed(1)]); }
    if (t < ${ms}) requestAnimationFrame(f); else res(out); };
  requestAnimationFrame(f); }))()`;
const OPACITY_ONLY = `((el) => { const props = new Set(); for (const a of el.getAnimations({ subtree: true })) { if (a.effect?.target?.matches?.("img, video")) continue;
  for (const k of a.effect?.getKeyframes?.() ?? []) for (const p of Object.keys(k)) if (!["offset", "easing", "composite", "computedOffset", "opacity"].includes(p)) props.add(p); }
  return [...props]; })`;
const vis = (f) => f[1] != null && f[1] > 0.02;
const full = (f) => f[1] != null && f[1] >= 0.95;
function judge(name, fr, { appear = false, leave = false, still = true, size = true, maxMs = 300 } = {}) {
  const v = [], J = JSON.stringify;
  if (!fr?.length || !fr.some(vis)) return [`${name}: never shown — proved nothing`];
  if (still) {
    let n = 0, ex = null;
    for (let i = 1; i < fr.length; i++) {
      const a = fr[i - 1], b = fr[i];
      if (a[1] == null || b[1] == null) continue;
      const d = Math.max(Math.abs(b[2] - a[2]), Math.abs(b[3] - a[3]), size ? Math.abs(b[4] - a[4]) : 0, size ? Math.abs(b[5] - a[5]) : 0);
      if (d > 0.75) { n++; ex ??= [a, b]; }
    }
    if (n) v.push(`${name}: moved or resized in ${n} frames (${J(ex)})`);
  }
  if (appear) {
    const i = fr.findIndex(vis);
    if (i === 0 && full(fr[0])) v.push(`${name}: already shown when the sampling began — proved nothing`);
    else {
      const j = fr.findIndex((f, k) => k >= i && full(f));
      const mid = fr.slice(i, j < 0 ? undefined : j).filter((f) => vis(f) && !full(f)).length;
      if (!mid) v.push(`${name}: popped in — no in-between opacity frame (${J(fr.slice(Math.max(0, i - 1), i + 2))})`);
      else if (j > 0 && fr[j][0] - fr[Math.max(0, i - 1)][0] > maxMs) v.push(`${name}: the fade in took ${fr[j][0] - fr[Math.max(0, i - 1)][0]} ms (want ≈ ${FADE_MS})`);
    }
  }
  if (leave) {
    const l = fr.findLastIndex(vis);
    if (l === fr.length - 1) v.push(`${name}: still shown when the sampling ended — proved nothing`);
    else {
      const f0 = fr.findLastIndex((f, k) => k <= l && full(f));
      const mid = fr.slice(f0 + 1, l + 1).filter((f) => vis(f) && !full(f)).length;
      if (!mid) v.push(`${name}: popped out — no in-between opacity frame (${J(fr.slice(Math.max(0, l - 1), l + 2))})`);
      else if (f0 >= 0 && fr[l + 1][0] - fr[f0][0] > maxMs) v.push(`${name}: the fade out took ${fr[l + 1][0] - fr[f0][0]} ms (want ≈ ${FADE_MS})`);
    }
  }
  return v;
}
// a one-line summary of a frame series for the log: the opacities seen, in order, collapsed
const brief = (fr) => (fr ?? []).map((f) => (f[1] == null ? "-" : f[1].toFixed(2))).filter((x, i, a) => i === 0 || x !== a[i - 1]).slice(0, 14).join(" ");
module.exports = { FADE_MS, SAMPLE, OPACITY_ONLY, judge, brief };
