// COOL: the Workshop filter column's "Filters · N" pill and the docked column's title are ONE control in two places. On a fold / unfold
// a ghost copy of the element being left flies to where the other one lands — translate + scale (transform-origin 0 0) with
// its background / colour / shadow easing into the target's — while the column slides and the grid glides (same duration +
// curve, so all three land together). The target stays hidden until the ghost arrives; the source is already gone (the pill
// isn't rendered while the column is out, the title leaves with the column).

export type MorphSource = { rect: DOMRect; node: HTMLElement; style: { bg: string; color: string; shadow: string; radius: string } };

export const MORPH_MS = 340;
const EASE = "cubic-bezier(.2, 1, .36, 1)";

// before the state change: what the ghost starts as
export function snapshot(el: Element | null): MorphSource | null {
  if (!(el instanceof HTMLElement)) return null;
  const cs = getComputedStyle(el);
  return { rect: el.getBoundingClientRect(), node: el.cloneNode(true) as HTMLElement,
    style: { bg: cs.backgroundColor, color: cs.color, shadow: cs.boxShadow, radius: cs.borderRadius } };
}

// where `el` will rest: its box minus the translate its ancestors are animating right now (the column's slide-in starts at
// -100 %, the grid's glide at ±the column's width) — those animations end when the ghost does
function restingRect(el: HTMLElement) {
  const r = el.getBoundingClientRect();
  let dx = 0, dy = 0;
  for (let a: HTMLElement | null = el; a; a = a.parentElement) {
    if (!a.getAnimations().length) continue;
    const t = getComputedStyle(a).transform;
    if (t && t !== "none") { const m = new DOMMatrixReadOnly(t); dx += m.e; dy += m.f; }
  }
  return { left: r.left - dx, top: r.top - dy, width: r.width, height: r.height };
}

// after the commit (a layout effect, before paint): fly `from` onto `to`
export function morph(from: MorphSource, to: Element | null) {
  if (!(to instanceof HTMLElement)) return;
  const end = restingRect(to);
  const cs = getComputedStyle(to);
  const g = from.node;
  g.removeAttribute("data-wf-open"); g.removeAttribute("data-wf-title"); g.removeAttribute("id");
  g.classList.add("wf-morph");
  g.setAttribute("aria-hidden", "true");
  Object.assign(g.style, { position: "fixed", left: `${from.rect.left}px`, top: `${from.rect.top}px`, width: `${from.rect.width}px`,
    height: `${from.rect.height}px`, margin: "0", zIndex: "60", pointerEvents: "none", transformOrigin: "0 0", boxSizing: "border-box" });
  document.body.append(g);
  // `transition: none` too: the pill's `transition: all` covers visibility, which then stays VISIBLE through its 150 ms
  // transition — the pill shows under the ghost on a fold (traced: inline hidden, computed visible until ~350 ms)
  to.style.transition = "none";
  to.style.visibility = "hidden";
  const sx = end.width / from.rect.width, sy = end.height / from.rect.height;
  const dx = end.left - from.rect.left, dy = end.top - from.rect.top;
  // COOL: mid-flight it lifts a touch (1.06×) and glows in the accent — one object travelling, not a swap — then settles into the
  // target's look. The midpoint's translate is the straight line's middle (the curve's ease comes from EASE, per segment).
  const a = g.animate([
    { offset: 0, transform: "none", backgroundColor: from.style.bg, color: from.style.color, boxShadow: from.style.shadow, borderRadius: from.style.radius },
    { offset: 0.5, transform: `translate(${dx / 2}px, ${dy / 2}px) scale(${(1 + sx) / 2 * 1.06}, ${(1 + sy) / 2 * 1.06})`,
      boxShadow: "0 0 22px -3px var(--accent), 0 6px 18px rgba(0,0,0,.35)" },
    { offset: 1, transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`,
      backgroundColor: cs.backgroundColor, color: cs.color, boxShadow: cs.boxShadow, borderRadius: cs.borderRadius },
  ], { duration: MORPH_MS, easing: EASE, fill: "forwards" });
  // the chevron TURNS on the way, never snaps: the copy
  // starts with the source's direction and the landing swaps it for the target's at once. Rotate the ghost's chevron between
  // the two (an `open` button points left = 0°, the folded pill right = 180°) on the same clock, with a springy overshoot.
  const gc = g.querySelector<SVGElement>(".wf-chev"), tc = to.querySelector(".wf-chev");
  if (gc && tc) {
    const deg = (el: Element) => (el.closest(".wf-open")?.classList.contains("open") ? 0 : 180);
    gc.style.transition = "none";
    gc.animate([{ transform: `rotate(${deg(gc)}deg)` }, { transform: `rotate(${deg(tc)}deg)` }],
      { duration: MORPH_MS, easing: "cubic-bezier(.3, 1.45, .45, 1)", fill: "forwards" });
  }
  const done = () => {
    g.remove();
    if (!to.isConnected) return;
    to.style.visibility = "";
    requestAnimationFrame(() => { to.style.transition = ""; }); // after the visible frame, so nothing fades in
  };
  a.onfinish = done; a.oncancel = done;
}
