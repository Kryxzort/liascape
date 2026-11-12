// A FLIP for the room something left (design.md § Motion: position changes glide): `snapFlip` before the leaving element
// unmounts, `glideFlip` after — each tracked element that moved plays the difference back on transform. Positions are
// measured against each element's own parent, so a parent that moved and its child that moved with it never add up.
// Motion off: don't call it (siblings take their new place at once; the leaving element itself fades).
export type FlipSnap = Map<Element, { x: number; y: number }>;

function measure(root: Element, sel: string): FlipSnap {
  const m: FlipSnap = new Map();
  for (const el of root.querySelectorAll(sel)) {
    const p = el.parentElement; if (!p) continue;
    const r = el.getBoundingClientRect(), pr = p.getBoundingClientRect();
    m.set(el, { x: r.left - pr.left, y: r.top - pr.top });
  }
  return m;
}

export const snapFlip = (root: Element | null, sel: string): FlipSnap | null => (root ? measure(root, sel) : null);

let tok: { e: string; ms: number } | null = null;
function spring() {
  if (tok) return tok;
  const cs = getComputedStyle(document.documentElement);
  const dur = cs.getPropertyValue("--spring-soft-dur").trim();
  tok = { e: cs.getPropertyValue("--spring-soft").trim() || "ease-out", ms: (parseFloat(dur) || 0.5) * (dur.endsWith("ms") ? 1 : 1000) };
  return tok;
}

export function glideFlip(before: FlipSnap | null, root: Element | null, sel: string) {
  if (!before || !root) return;
  const { e, ms } = spring();
  for (const [el, now] of measure(root, sel)) {
    const was = before.get(el); if (!was) continue;
    const dx = was.x - now.x, dy = was.y - now.y;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
    el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: ms, easing: e });
  }
}
