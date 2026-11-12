// Is a round icon button's glyph centred in its own drawn chip — as the eye sees it, in pixels, not layout boxes?
// (Layout boxes say "centred" while a fractional chip size, an odd glyph in an even box or a half-pixel position puts the
// drawn glyph half a pixel or more off: it reads as off-centre on screen.)
//
//   const PXC = require("./pixel-centre");
//   const r = await PXC.measure(win, { chip: "<selector of the chip>", glyph: "<selector of its glyph>", css: "<extra css>",
//                                      png: "<path for an 8x close-up, optional>" });
//   r = { dx, dy, glyphPx, chipPx, glyph: [x0, y0, x1, y1], box: [x0, y0, x1, y1], scale } | { error }
//   PXC.judge(name, r, tol = 0.5)  → [] or the violations (off by more than `tol` css px, nothing drawn — proved nothing)
//
// Three captures of the chip's area: A as shown, B with the glyph hidden (visibility), C with the whole chip hidden. The
// glyph's box = the pixels where A ≠ B, the chip's box = where B ≠ C (its fill, its edge or ring), both read only inside the
// chip's layout box and 2 device pixels around it (a change elsewhere — a hover moving off the hidden chip — isn't the chip);
// (dx, dy) = the glyph box's centre minus the chip box's, in css px. Both selectors must match one element each (the first match is used).
// A fourth capture, as shown again, must match the first (else something moved under the chip meanwhile: the measurement
// is retried, up to `tries` times, then reported as an error rather than a wrong offset).
// Before measuring: settle what moves under the chip (pause a <video>, finish the icon's one-shots); a hover glow is part of
// the chip's box — pass `css` that removes it (`box-shadow: none`) to measure against the ring itself, and hide anything
// that overlaps the chip but isn't it (a pill sliding out from under it).
// The technique comes from probe-steam look:dlCentre. Used by probe-sidebar look:iconCentre.
const fs = require("fs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STYLE = "__pxc";

async function measure(win, opts) {
  let r;
  for (let i = 0; i < (opts.tries ?? 3); i++) { r = await once(win, opts); if (!r.moved) return r; await sleep(300); }
  return { error: `the picture under ${opts.chip} kept changing while it was measured (${r.moved} px) — settle it first` };
}

async function once(win, { chip, glyph, css = "", png = null, pad = 6, glyphThresh = 48, chipThresh = 24 }) {
  const wc = win.webContents, J = JSON.stringify;
  const setCss = (text) => wc.executeJavaScript(`(() => { let s = document.getElementById(${J(STYLE)}); if (!s) { s = document.createElement("style"); s.id = ${J(STYLE)};
    document.head.append(s); } s.textContent = ${J(text)}; return true; })()`);
  try {
    await setCss(css); await sleep(120);
    const b = await wc.executeJavaScript(`(() => { const e = document.querySelector(${J(chip)}); if (!e || !e.querySelector(${J(glyph)}) && !document.querySelector(${J(glyph)})) return null;
      const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
    if (!b) return { error: `no ${chip} / ${glyph}` };
    const rect = { x: Math.max(0, Math.floor(b.x) - pad), y: Math.max(0, Math.floor(b.y) - pad), width: Math.ceil(b.w) + 2 * pad + 1, height: Math.ceil(b.h) + 2 * pad + 1 };
    const A = await wc.capturePage(rect);
    await setCss(`${css}\n${glyph} { visibility: hidden !important; }`); await sleep(120);
    const B = await wc.capturePage(rect);
    await setCss(`${css}\n${chip} { visibility: hidden !important; }`); await sleep(120);
    const C = await wc.capturePage(rect);
    await setCss(css); await sleep(120);
    const A2 = await wc.capturePage(rect);
    const { width: W, height: H } = A.getSize(), scale = W / rect.width;
    const X0 = Math.max(0, Math.floor((b.x - rect.x) * scale) - 2), X1 = Math.min(W - 1, Math.ceil((b.x + b.w - rect.x) * scale) + 2);
    const Y0 = Math.max(0, Math.floor((b.y - rect.y) * scale) - 2), Y1 = Math.min(H - 1, Math.ceil((b.y + b.h - rect.y) * scale) + 2);
    const box = (P, Q, t) => {
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, n = 0;
      for (let y = Y0; y <= Y1; y++) for (let x = X0; x <= X1; x++) {
        const i = (y * W + x) * 4, d = Math.abs(P[i] - Q[i]) + Math.abs(P[i + 1] - Q[i + 1]) + Math.abs(P[i + 2] - Q[i + 2]);
        if (d > t) { n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      }
      return { n, b: [x0, y0, x1, y1], cx: (x0 + x1 + 1) / 2, cy: (y0 + y1 + 1) / 2 };
    };
    const a = A.toBitmap(), bb = B.toBitmap(), c = C.toBitmap();
    const moved = box(a, A2.toBitmap(), chipThresh).n;
    if (moved > 3) return { moved };
    const g = box(a, bb, glyphThresh), k = box(bb, c, chipThresh);
    if (png) fs.writeFileSync(png, A.resize({ width: W * 8, quality: "good" }).toPNG());
    return { dx: (g.cx - k.cx) / scale, dy: (g.cy - k.cy) / scale, glyphPx: g.n, chipPx: k.n, glyph: g.b, box: k.b, scale };
  } finally {
    await wc.executeJavaScript(`document.getElementById(${J(STYLE)})?.remove(); true`).catch(() => {});
  }
}

function judge(name, r, tol = 0.5) {
  if (!r || r.error) return [`${name}: ${r?.error ?? "not measured"}`];
  if (!r.glyphPx) return [`${name}: no glyph pixels — proved nothing`];
  if (!r.chipPx) return [`${name}: the chip draws nothing to centre in — proved nothing`];
  if (Math.abs(r.dx) > tol || Math.abs(r.dy) > tol)
    return [`${name}: the glyph is off its chip's centre by (${r.dx.toFixed(2)}, ${r.dy.toFixed(2)}) css px (glyph ${JSON.stringify(r.glyph)}, chip ${JSON.stringify(r.box)})`];
  return [];
}

module.exports = { measure, judge };
