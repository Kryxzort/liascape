import { useEffect, type RefObject } from "react";
import { useStore } from "../store";

// UX: card-size = a target VISIBLE COUNT (N), not a fixed card width. Holding count constant
// on resize while ALSO honoring the thumbnail aspect ratio means columns must vary with the window:
//   cardArea = containerArea / N ,  cardW = cardH * aspect  ⇒  cardW = √(containerArea * aspect / N)
//   cols = round(containerW / cardW)
// So a wide window → more cols/fewer rows, a narrow window → fewer cols/more rows, but cols × rows ≈ N
// and every card keeps `--thumb-aspect` (1:1 stays square, 16:9 stays 16:9).
const COUNT: Record<string, number> = { Small: 54, Medium: 35, Large: 20 };
const MIN_CARD_W = 100; // px — hard floor that only rescues genuinely tiny windows; lets Small stay small

export function useGridFit(ref: RefObject<HTMLElement | null>) {
  const size = (useStore((s) => s.settings?.cardSize as string)) ?? "Medium";
  const aspectStr = (useStore((s) => s.settings?.thumbnailAspect as string)) ?? "16:9";
  const aspect = aspectStr === "1:1" ? 1 : 16 / 9; // w/h
  const n = COUNT[size] ?? 20;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = () => {
      const cs = getComputedStyle(el);
      const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
      // use the TOP padding for both sides — the bottom padding is dynamic (reserves space for the
      // overlaid playlist strip via --strip-h); counting it would resize cards when the bar expands.
      const padTop = parseFloat(cs.paddingTop) || 0;
      const gap = parseFloat(cs.getPropertyValue("--gap")) || 14;
      const w = el.clientWidth - padX;
      const h = el.clientHeight - padTop * 2;
      if (w <= 0 || h <= 0) return;
      // Search integer column counts; for each, derive the card height (aspect-locked) and how many
      // rows FULLY fit, then take the cols whose fully-visible count (cols × rows) is closest to N.
      // (A pure √ estimate rounds cols once and lets the count drift; this minimizes the drift.)
      let best = 1, bestDiff = Infinity;
      for (let c = 1; c <= n; c++) {
        const cardW = (w - (c - 1) * gap) / c;
        if (cardW <= 0) break;
        const cardH = cardW / aspect;
        const rows = Math.max(1, Math.floor((h + gap) / (cardH + gap)));
        const diff = Math.abs(c * rows - n);
        if (diff < bestDiff) { bestDiff = diff; best = c; }
      }
      // enforce a minimum card width — drop columns until each card is ≥ MIN_CARD_W so small windows
      // (or the Small setting) don't produce a hideous grid of unusably tiny cards.
      while (best > 1 && (w - (best - 1) * gap) / best < MIN_CARD_W) best--;
      el.style.setProperty("--cols", String(best));
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => { ro.disconnect(); el.style.removeProperty("--cols"); };
  }, [ref, aspect, n]);
}
