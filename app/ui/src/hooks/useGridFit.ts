import { useLayoutEffect, useRef, type RefObject } from "react";
import { useStore } from "../store";

// UX: card-size = a target VISIBLE COUNT (N), not a fixed card width. Holding count constant
// on resize while ALSO honoring the thumbnail aspect ratio means columns must vary with the window:
//   cardArea = containerArea / N ,  cardW = cardH * aspect  ⇒  cardW = √(containerArea * aspect / N)
//   cols = round(containerW / cardW)
// So a wide window → more cols/fewer rows, a narrow window → fewer cols/more rows, but cols × rows ≈ N
// and every card keeps `--thumb-aspect` (1:1 stays square, 16:9 stays 16:9).
// A docked panel (the item sidebar's margin-right, the Workshop filter column's margin-left) is not a smaller window: the
// count is fitted to the grid as if no panel were open, and with one open the grid takes the column count whose card
// width is closest to that size — the panel drops columns, the cards keep their size. Guard: probe-layout grid:panel,
// probe-filters wf:cardSize.
const COUNT: Record<string, number> = { Small: 54, Medium: 35, Large: 20 };
const MIN_CARD_W = 100; // px — hard floor that only rescues genuinely tiny windows; lets Small stay small

// the column count each grid (`key`) last fit to: a page mounting again (a tab switch) starts with it
const lastCols = new Map<string, string>();

const cardW = (w: number, cols: number, gap: number) => (w - (cols - 1) * gap) / cols;

// Search integer column counts; for each, derive the card height (aspect-locked) and how many rows FULLY fit, then take
// the cols whose fully-visible count (cols × rows) is closest to N. (A pure √ estimate rounds cols once and lets the
// count drift; this minimizes the drift.)
function fitCols(w: number, h: number, gap: number, aspect: number, n: number): number {
  let best = 1, bestDiff = Infinity;
  for (let c = 1; c <= n; c++) {
    const cw = cardW(w, c, gap);
    if (cw <= 0) break;
    const rows = Math.max(1, Math.floor((h + gap) / (cw / aspect + gap)));
    const diff = Math.abs(c * rows - n);
    if (diff < bestDiff) { bestDiff = diff; best = c; }
  }
  // enforce a minimum card width — drop columns until each card is ≥ MIN_CARD_W so small windows
  // (or the Small setting) don't produce a hideous grid of unusably tiny cards.
  while (best > 1 && cardW(w, best, gap) < MIN_CARD_W) best--;
  return best;
}

// The grid fills its width (1fr columns), so a width between two counts' cards can't be hit exactly: the closer of the
// two neighbours is at most half a column's share off. No MIN_CARD_W here — the target already passed it, and the floor
// would push a pick just under it a whole column further away.
function colsNear(w: number, gap: number, target: number): number {
  const c = Math.max(1, Math.floor((w + gap) / (target + gap)));
  return Math.abs(cardW(w, c + 1, gap) - target) < Math.abs(cardW(w, c, gap) - target) ? c + 1 : c;
}

function bind(el: HTMLElement, key: string, aspect: number, n: number): () => void {
  const apply = () => {
    const cs = getComputedStyle(el);
    const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    // use the TOP padding for both sides — the bottom padding is dynamic (reserves space for the
    // overlaid playlist bar via --playlist-bar-h); counting it would resize cards when the bar expands.
    const padTop = parseFloat(cs.paddingTop) || 0;
    const gap = parseFloat(cs.getPropertyValue("--gap")) || 14;
    // the docked panels' room (the grid has no side margins of its own); computed style is clean in this callback
    const panels = (parseFloat(cs.marginLeft) || 0) + (parseFloat(cs.marginRight) || 0);
    const w = el.clientWidth - padX;
    const h = el.clientHeight - padTop * 2;
    if (w <= 0 || h <= 0) return;
    let best = fitCols(w + panels, h, gap, aspect, n);
    if (panels > 0) best = colsNear(w, gap, cardW(w + panels, best, gap));
    // unchanged → no write: even a same-value write may restyle the grid
    if (el.style.getPropertyValue("--cols") !== String(best)) el.style.setProperty("--cols", String(best));
    lastCols.set(key, String(best));
  };
  const prev = lastCols.get(key);
  if (prev) el.style.setProperty("--cols", prev);
  const ro = new ResizeObserver(apply);
  ro.observe(el);
  return () => { ro.disconnect(); el.style.removeProperty("--cols"); };
}

export function useGridFit(ref: RefObject<HTMLElement | null>, key: string) {
  const size = (useStore((s) => s.settings?.cardSize as string)) ?? "Medium";
  // only an explicit 16:9 is widescreen: before the settings load (and for any other value) it's the real default, 1:1;
  // App.tsx's --thumb-aspect follows the same rule
  const aspect = useStore((s) => s.settings?.thumbnailAspect) === "16:9" ? 16 / 9 : 1; // w/h
  const n = COUNT[size] ?? 20;
  const bound = useRef<{ el: HTMLElement; aspect: number; n: number; key: string; unbind: () => void } | null>(null);
  // PERF: no measuring at mount — the ResizeObserver's first callback fits the grid (it runs after the frame's layout,
  // before its paint, so the first painted frame has the right columns). Measuring in a mount effect forced a layout of
  // the whole new page inside the tab switch, and the first layout ran with the default column count, then again with the
  // fitted one; the last fit's count goes on before that layout instead, so it's usually right the first time.
  // Guard: probe-layout perf:tabs.
  // Runs after every render (no deps): the scroll element can appear later than the hook (the Library renders a
  // placeholder until its items arrive), and only a render of the hook's own component can mount it — a comparison per
  // render, a new binding only when the element, the aspect or the count changed. Guard: probe-layout grid:boot.
  useLayoutEffect(() => {
    const el = ref.current, b = bound.current;
    if (b && b.el === el && b.aspect === aspect && b.n === n && b.key === key) return;
    b?.unbind();
    bound.current = el ? { el, aspect, n, key, unbind: bind(el, key, aspect, n) } : null;
  });
  useLayoutEffect(() => () => { bound.current?.unbind(); bound.current = null; }, []);
}
