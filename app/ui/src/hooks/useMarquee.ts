import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { useStore } from "../store";
import { motionOn } from "../components/motion";
import { useStableFn } from "./useStableFn";

// Box (marquee) selection in a card grid (Library, Browse): a drag that starts on the grid's empty space draws a rectangle
// and selects the cards it touches — the same `sel` + `anchor` Ctrl / Shift-click build, so every bulk action applies
// unchanged. A plain drag replaces the selection, Ctrl+drag adds to it, Escape restores the one before the drag; afterwards
// the anchor is the box's first card in reading order (a Shift+click ranges from it). A move under THRESHOLD px stays a
// click (the view's empty-space click clears the selection). A drag starting on a card is the card's own.
// Guard: probe-select (every cell).
const THRESHOLD = 4;
// the auto-scroll band at the container's top / bottom edge and its top speed (px per ms at the band's far edge — about
// 22 px a 60 Hz frame; past the edge, out of the window, it keeps speeding up to twice that)
const EDGE = 44;
const SPEED = 1.3;
// the fill strengthens as the box catches cards: full at this many (index.css `.marquee::before`, opacity `--mq`)
const FULL_AT = 12;
const OUT_MS = 160; // index.css `.marquee.out`

type Opts = {
  // the cards' `data-morph-id` prefix (`lib-` / `br-`); the rest of it is the item's selection key
  prefix: string;
  sel: Set<string>;
  setSel: (s: Set<string>) => void;
  anchor: { current: string | null };
};
type Box = { id: string; l: number; t: number; r: number; b: number };

// PERF: one handler for the scroll container's onPointerDown. A pointermove only records where the pointer is; the work runs
// once a frame in a rAF tick. Card rects are read once when the drag starts (and again only when the grid's layout changes —
// a ResizeObserver callback, where the layout is already clean: content-visibility placeholders taking their real size as
// they scroll near). They're kept in the scroll content's coordinates, so scrolling (auto or the wheel) needs no re-read.
// The selection is set only when the caught set changes: the cards are memo'd, only those whose `selected` flips re-render.
// Guard: probe-select perf:drag.
export function useMarquee(scrollRef: RefObject<HTMLElement | null>, o: Opts): (e: React.PointerEvent) => void {
  const opts = useRef(o);
  useLayoutEffect(() => { opts.current = o; });
  const live = useRef<(() => void) | null>(null);
  useEffect(() => () => live.current?.(), []); // the view unmounted mid-drag: no overlay or listener outlives it

  return useStableFn((e: React.PointerEvent) => {
    const sc = scrollRef.current;
    const t = e.target as HTMLElement;
    if (!sc || live.current || e.button !== 0 || e.pointerType !== "mouse") return;
    const grid = [...sc.children].find((c) => c.classList.contains("grid")) as HTMLElement | undefined;
    if (!grid || (t !== sc && t !== grid)) return;
    if (t === sc && e.nativeEvent.offsetX >= sc.clientWidth) return; // the scrollbar

    const { prefix } = opts.current;
    const prev = opts.current.sel, anchor0 = opts.current.anchor.current;
    const add = e.ctrlKey || e.metaKey;
    const x0 = e.clientX, y0 = e.clientY, top0 = sc.scrollTop;
    let px = x0, py = y0;
    let active = false, cancelled = false;
    let cx = 0, cy = 0, cw = 0, ch = 0, sx = 0, sy = 0, st = top0, maxTop = 0;
    let boxes: Box[] = [];
    let hitKey = "", first: string | null = null;
    let raf = 0, lastT = 0, scrolled = false;
    let clip: HTMLDivElement | null = null, box: HTMLDivElement | null = null;
    let ro: ResizeObserver | null = null;

    // the cards' rects in content coordinates (reading order = DOM order); the container's client box for the overlay
    const measure = () => {
      const c = sc.getBoundingClientRect();
      st = sc.scrollTop;
      cx = c.left + sc.clientLeft; cy = c.top + sc.clientTop; cw = sc.clientWidth; ch = sc.clientHeight;
      maxTop = sc.scrollHeight - ch;
      boxes = [];
      for (const card of grid.children) {
        const id = (card.firstElementChild as HTMLElement | null)?.dataset.morphId;
        if (!id?.startsWith(prefix)) continue; // placeholders (Browse's skeleton cards)
        const r = card.getBoundingClientRect();
        boxes.push({ id: id.slice(prefix.length), l: r.left - cx, t: r.top - cy + st, r: r.right - cx, b: r.bottom - cy + st });
      }
      if (clip) Object.assign(clip.style, { left: `${cx}px`, top: `${cy}px`, width: `${cw}px`, height: `${ch}px` });
    };

    const begin = () => {
      active = true;
      measure();
      sx = x0 - cx; sy = y0 - cy + top0;
      clip = document.createElement("div"); clip.className = "marquee-clip";
      box = document.createElement("div"); box.className = "marquee";
      clip.appendChild(box);
      Object.assign(clip.style, { left: `${cx}px`, top: `${cy}px`, width: `${cw}px`, height: `${ch}px` });
      document.body.appendChild(clip);
      // the cards take no pointer while the box is drawn: no hover lift / preview under the sweeping pointer
      sc.classList.add("marquee-on");
      ro = new ResizeObserver(() => { if (active) { measure(); frame(); } });
      ro.observe(grid);
    };

    const draw = () => {
      // the pointer's corner in content coordinates, kept inside the content
      const ex = Math.min(Math.max(px - cx, 0), cw), ey = Math.min(Math.max(py - cy + st, 0), maxTop + ch);
      const l = Math.min(sx, ex), r = Math.max(sx, ex), tp = Math.min(sy, ey), b = Math.max(sy, ey);
      const hit: string[] = [];
      for (const k of boxes) if (k.l < r && k.r > l && k.t < b && k.b > tp) hit.push(k.id);
      if (box) {
        box.style.transform = `translate(${l}px, ${tp - st}px)`;
        box.style.width = `${r - l}px`; box.style.height = `${b - tp}px`;
        box.style.setProperty("--mq", String(Math.min(1, hit.length / FULL_AT)));
      }
      const key = hit.join("\n");
      if (key === hitKey) return;
      hitKey = key; first = hit[0] ?? null;
      const next = new Set(add ? prev : []);
      for (const id of hit) next.add(id);
      opts.current.setSel(next);
    };

    // auto-scroll speed (px per ms) from how deep the pointer is in the top / bottom band
    const speed = () => {
      const up = cy + EDGE - py, down = py - (cy + ch - EDGE);
      const d = up > 0 ? -up : down > 0 ? down : 0;
      return d ? Math.sign(d) * SPEED * Math.min(2, Math.abs(d) / EDGE) : 0;
    };

    const tick = (now: number) => {
      raf = 0;
      if (!active) return;
      if (scrolled) { st = sc.scrollTop; scrolled = false; }
      const v = speed();
      const dt = lastT ? Math.min(50, now - lastT) : 16;
      lastT = now;
      if (v && (v < 0 ? st > 0 : st < maxTop)) {
        st = Math.min(maxTop, Math.max(0, st + v * dt));
        sc.scrollTop = st;
      }
      draw();
      if (v) raf = requestAnimationFrame(tick); else lastT = 0;
    };
    const frame = () => { if (!raf) raf = requestAnimationFrame(tick); };

    // the wheel (or anything) scrolled the container under a held box: follow it (read in the frame's tick)
    const onScroll = () => { scrolled = true; if (active) frame(); };

    const finish = () => {
      cancelAnimationFrame(raf); raf = 0;
      ro?.disconnect();
      sc.classList.remove("marquee-on");
      sc.removeEventListener("scroll", onScroll);
      const c = clip;
      if (c) {
        const motion = motionOn(useStore.getState().settings);
        if (motion) { c.firstElementChild?.classList.add("out"); setTimeout(() => c.remove(), OUT_MS); } else c.remove();
      }
      clip = box = null;
    };
    const unbind = () => {
      removeEventListener("pointermove", onMove, true);
      removeEventListener("pointerup", onUp, true);
      removeEventListener("pointercancel", onUp, true);
      removeEventListener("keydown", onKey, true);
      removeEventListener("blur", onUp);
      live.current = null;
    };

    const onMove = (ev: PointerEvent) => {
      px = ev.clientX; py = ev.clientY;
      if (cancelled) return;
      if (!active) {
        if (Math.hypot(px - x0, py - y0) < THRESHOLD) return;
        begin();
      }
      frame();
    };
    const onUp = (ev: Event) => {
      unbind();
      if (!active && !cancelled) return; // a click: the view's own click handling
      if (active) {
        if (ev instanceof PointerEvent) { px = ev.clientX; py = ev.clientY; }
        draw();
        if (first) opts.current.anchor.current = first;
        active = false;
        finish();
      }
      // the click this release makes lands on the empty space, whose click clears the selection
      const eat = (c: MouseEvent) => { c.stopPropagation(); c.preventDefault(); };
      addEventListener("click", eat, true);
      setTimeout(() => removeEventListener("click", eat, true), 0);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape" || !active) return;
      // the box's Escape: the selection before the drag comes back (the views' Escape would clear it and the sidebar)
      ev.preventDefault(); ev.stopImmediatePropagation();
      active = false; cancelled = true;
      finish();
      opts.current.setSel(prev);
      opts.current.anchor.current = anchor0;
    };

    addEventListener("pointermove", onMove, true);
    addEventListener("pointerup", onUp, true);
    addEventListener("pointercancel", onUp, true);
    addEventListener("keydown", onKey, true);
    addEventListener("blur", onUp);
    sc.addEventListener("scroll", onScroll, { passive: true });
    live.current = () => { unbind(); active = false; finish(); };
  });
}
