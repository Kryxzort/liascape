// A card's type icon (app/ui/src/components/TypeIcon.tsx) and the item sidebar's type chip, read the same way on the
// Library (probe-sidebar lib:type:icon) and on Browse (probe-filters filter:type:icon), so both tabs are held to one icon.
//
//   const TI = require("./type-icon");
//   TI.KINDS                    → { scene: { label, lucide }, preset: { label, lucide } }; a video has none
//   await page(TI.readCard(cardJs))  → what the card shows: { kind, label, title, aria, role, lucide, dx, dy, w, h, pill, filter,
//                                       badges } (kind null = no icon); `cardJs` is an in-page expression for the card's element
//   await page(TI.readChip(sideJs))  → the sidebar's type chip: { kind, text, lucide, bg, shown } (kind null = none)
//   TI.judgeCard(tag, name, want, got) / TI.judgeChip(…) → [] or the violations
//   await TI.contrast(win, cardJs, bg) → (cardJs self-contained: no probe helper `m` in scope)
//                                     { stroke, ring, ratio, px } — the glyph drawn over a flat `bg` picture: the mean
//                                       luminance of its strokes and of the 2 css px around them (its shadow), as drawn
//
// Contrast, as the eye sees it: capture S hides the shadow on a black picture, so the strokes are its bright pixels (the
// mask); capture A shows the icon as it is over `bg`; the mask's mean luminance in A against its ring's (the mask grown by
// 2 css px, minus the mask). WCAG's 3:1 for graphics is the floor (`MIN_CONTRAST`).
const J = JSON.stringify;
const KINDS = { scene: { label: "Scene", lucide: "lucide-box" }, preset: { label: "Preset", lucide: "lucide-sliders-horizontal" } };
const MIN_CONTRAST = 3;
const STYLE = "__ti";

// in-page JS (a function body for the probes' `page()`): the card's icon, measured from its picture's corner
const readCard = (cardJs) => `const c = ${cardJs}, w = c?.querySelector(".thumb-wrap"); if (!w) return null;
  const e = w.querySelector(":scope > .type-ico"), badges = [...w.querySelectorAll(":scope > .badge:not(.inlib)")].map((b) => b.textContent.trim());
  if (!e) return { kind: null, badges };
  const s = getComputedStyle(e), r = e.getBoundingClientRect(), b = w.getBoundingClientRect(), svg = e.querySelector("svg");
  const lucide = [...(svg?.classList ?? [])].find((k) => k.startsWith("lucide-") && k !== "lucide-icon") ?? null;
  return { kind: e.dataset.type ?? null, title: e.title, aria: e.getAttribute("aria-label"), role: e.getAttribute("role"), lucide,
    text: e.textContent.trim(), dx: Math.round(r.left - b.left), dy: Math.round(r.top - b.top), w: Math.round(r.width), h: Math.round(r.height),
    pill: !/^rgba\\(0, 0, 0, 0\\)$|^transparent$/.test(s.backgroundColor) || s.boxShadow !== "none" || parseFloat(s.borderTopWidth) > 0,
    filter: s.filter, color: s.color, badges };`;

const readChip = (sideJs) => `const side = ${sideJs}; if (!side) return null;
  const c = side.querySelector(".side-hero > [data-side-type]"), old = [...side.querySelectorAll(".side-hero > .side-chip")].map((x) => x.textContent.trim())
    .filter((t) => /^(SCENE|PRESET)$/.test(t));
  if (!c) return { kind: null, old };
  const svg = c.querySelector("svg"), lucide = [...(svg?.classList ?? [])].find((k) => k.startsWith("lucide-") && k !== "lucide-icon") ?? null;
  const s = getComputedStyle(c), r = c.getBoundingClientRect();
  const shown = s.display !== "none" && s.visibility === "visible" && +s.opacity > 0 && r.width > 0 && r.height > 0 && !c.closest("[hidden], [aria-hidden='true']");
  return { kind: c.dataset.sideType, text: c.textContent.trim(), cls: c.className, lucide, bg: s.backgroundColor, shown, old };`;

function judgeCard(tag, name, want, got) {
  const v = [];
  if (!got) return [`${tag}: ${name}'s card isn't on screen — proved nothing`];
  if (got.badges?.length) v.push(`${tag}: ${name}'s card still has a pill badge ${J(got.badges)}`);
  if (!want) { if (got.kind) v.push(`${tag}: ${name} (a video) shows a type icon ${J(got)}, want none`); return v; }
  const k = KINDS[want];
  if (got.kind !== want) return [...v, `${tag}: ${name}'s card shows ${J(got.kind)}, want the ${want} icon`];
  if (got.lucide !== k.lucide) v.push(`${tag}: ${name}'s icon is ${J(got.lucide)}, want ${k.lucide}`);
  if (got.title !== k.label || got.aria !== k.label) v.push(`${tag}: ${name}'s tooltip ${J(got.title)} / label ${J(got.aria)}, want ${J(k.label)}`);
  if (got.role !== "img") v.push(`${tag}: ${name}'s icon has role ${J(got.role)}, want img (its label read out)`);
  if (got.text) v.push(`${tag}: ${name}'s icon has words ${J(got.text)} — an icon, not a tag`);
  if (got.pill) v.push(`${tag}: ${name}'s icon sits on a pill (a fill, ring or border) ${J(got)}`);
  if (got.w < 14 || got.w > 16 || got.h < 14 || got.h > 16) v.push(`${tag}: ${name}'s icon is ${got.w}×${got.h}, want 14–16 px`);
  if (!/drop-shadow/.test(got.filter)) v.push(`${tag}: ${name}'s icon has no shadow to read on a picture (filter ${J(got.filter)})`);
  return v;
}

function judgeChip(tag, name, want, got) {
  if (!got) return [`${tag}: ${name}'s sidebar isn't open — proved nothing`];
  const v = got.old?.length ? [`${tag}: ${name}'s sidebar still has the old tag ${J(got.old)}`] : [];
  if (!want) { if (got.kind) v.push(`${tag}: ${name} (a video) has a type chip ${J(got)}`); return v; }
  const k = KINDS[want];
  if (got.kind !== want) return [...v, `${tag}: ${name}'s sidebar type chip is ${J(got.kind)}, want ${want}`];
  if (!got.shown) v.push(`${tag}: ${name}'s sidebar type chip isn't visible ${J(got)}`);
  if (got.lucide !== k.lucide) v.push(`${tag}: ${name}'s sidebar chip icon ${J(got.lucide)} — not the card's ${k.lucide}`);
  if (got.text !== k.label) v.push(`${tag}: ${name}'s sidebar chip says ${J(got.text)}, want ${J(k.label)} beside its icon`);
  return v;
}

const lum = (bm, i) => { // BGRA → WCAG relative luminance
  const ch = (x) => { x /= 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * ch(bm[i + 2]) + 0.7152 * ch(bm[i + 1]) + 0.0722 * ch(bm[i]);
};

async function contrast(win, cardJs, bg) {
  const wc = win.webContents, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const run = (body) => wc.executeJavaScript(`(async () => { ${body} })()`);
  const setCss = (text) => run(`let s = document.getElementById(${J(STYLE)}); if (!s) { s = document.createElement("style"); s.id = ${J(STYLE)};
    document.head.append(s); } s.textContent = ${J(text)}; return true;`);
  const at = await run(`const c = ${cardJs}; document.querySelectorAll("[data-ti-probe]").forEach((x) => x.removeAttribute("data-ti-probe"));
    const e = c?.querySelector(".thumb-wrap > .type-ico"); if (!e) return null; c.setAttribute("data-ti-probe", ""); e.scrollIntoView({ block: "nearest" });
    await new Promise((r) => setTimeout(r, 120)); const r = e.getBoundingClientRect(); return { x: r.x - 6, y: r.y - 6, w: r.width + 12, h: r.height + 12 };`);
  if (!at) return { error: "no type icon on the card" };
  const rect = { x: Math.round(at.x), y: Math.round(at.y), width: Math.round(at.w), height: Math.round(at.h) };
  const flat = (c) => `[data-ti-probe] .thumb-wrap > :not(.type-ico) { visibility: hidden !important; }
    [data-ti-probe] .thumb-wrap { background: ${c} !important; }`;
  try {
    await setCss(`${flat("#000")} [data-ti-probe] .type-ico { filter: none !important; }`); await sleep(120);
    const S = await wc.capturePage(rect);
    await setCss(flat(bg)); await sleep(120);
    const A = await wc.capturePage(rect);
    const { width: W, height: H } = S.getSize(), s = S.toBitmap(), a = A.toBitmap(), sf = W / rect.width, R = Math.max(1, Math.round(2 * sf));
    const mask = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) mask[i] = lum(s, i * 4) > 0.35 ? 1 : 0;
    let sum = 0, n = 0, rs = 0, rn = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (mask[i]) { sum += lum(a, i * 4); n++; continue; }
      let near = false;
      for (let dy = -R; dy <= R && !near; dy++) for (let dx = -R; dx <= R; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < W && yy < H && dx * dx + dy * dy <= R * R && mask[yy * W + xx]) { near = true; break; }
      }
      if (near) { rs += lum(a, i * 4); rn++; }
    }
    if (!n || !rn) return { error: `nothing drawn (stroke ${n} px, ring ${rn} px)` };
    const stroke = sum / n, ring = rs / rn, ratio = (Math.max(stroke, ring) + 0.05) / (Math.min(stroke, ring) + 0.05);
    return { stroke: +stroke.toFixed(3), ring: +ring.toFixed(3), ratio: +ratio.toFixed(2), px: n };
  } finally {
    await setCss("");
    await run(`document.querySelectorAll("[data-ti-probe]").forEach((x) => x.removeAttribute("data-ti-probe")); return true;`);
  }
}

module.exports = { KINDS, MIN_CONTRAST, readCard, readChip, judgeCard, judgeChip, contrast };
