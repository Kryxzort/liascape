import { useEffect, type RefObject } from "react";

// Smooth wheel scrolling: wheel adds velocity; a rAF loop eases the offset with friction decay →
// momentum scrolling (the native Electron scroll is instant). Skips inputs/sliders so spinners keep
// their own wheel behavior.
// Per-tick travel = (added velocity)/(1 - FRICTION) = delta·(IMPULSE/100)/(1-FRICTION). Travel ∝ IMPULSE
// (friction sets the coast duration, IMPULSE the distance): ~1.5× native travel over a ~1.6s glide.
const IMPULSE = 7.5;
const FRICTION = 0.95;     // per 16ms frame — higher = longer glide (travel held via IMPULSE)
const MAX_VELOCITY = 2500;
const STOP = 0.1;

// `deps` lets callers re-attach when a lazily-mounted scroll element appears (e.g. a dropdown popover
// that only mounts when open → pass [open] so the hook re-runs and binds the now-present element).
export function useSmoothScroll(ref: RefObject<HTMLElement | null>, axis: "y" | "x" = "y", deps: unknown[] = []) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let velocity = 0;
    let animating = false;
    let last = 0;

    // PERF: the scroll extent (scrollHeight/scrollWidth) is a *layout-dependent* read. With
    // content-visibility:auto cards toggling visibility mid-scroll, layout is dirty every frame, so
    // reading it inside the rAF loop forced a synchronous reflow 60×/s (self-inflicted scroll jank).
    // Cache `max` and refresh it only on wheel + ResizeObserver — never in the frame loop.
    let max = 0;
    const measure = () => {
      max = axis === "x"
        ? Math.max(0, el.scrollWidth - el.clientWidth)
        : Math.max(0, el.scrollHeight - el.clientHeight);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild); // content grows (LoadMore) → re-measure

    const frame = (t: number) => {
      if (!animating) return;
      const dt = last ? Math.min(t - last, 64) : 16;
      last = t;
      velocity *= Math.pow(FRICTION, dt / 16);
      if (Math.abs(velocity) < STOP) { animating = false; velocity = 0; return; }
      const cur = axis === "x" ? el.scrollLeft : el.scrollTop;
      const n = Math.min(max, Math.max(0, cur + velocity * (dt / 16)));
      if (n <= 0 || n >= max) velocity = 0; // hit a boundary → kill momentum
      if (axis === "x") el.scrollLeft = n; else el.scrollTop = n;
      requestAnimationFrame(frame);
    };

    const onWheel = (e: WheelEvent) => {
      // let sliders/number inputs handle their own wheel
      const tgt = e.target as HTMLElement | null;
      if (tgt?.closest("input,select,textarea,[role=slider]")) return;
      const delta = axis === "x" ? (e.deltaX || e.deltaY) : (e.deltaY || e.deltaX);
      if (!delta) return;
      e.preventDefault();
      measure(); // user input boundary: re-measure here (cheap, not per-frame) so loadmore growth lands
      velocity = Math.max(-MAX_VELOCITY, Math.min(MAX_VELOCITY, velocity + delta * (IMPULSE / 100)));
      if (!animating) { animating = true; last = 0; requestAnimationFrame(frame); }
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    return () => { animating = false; ro.disconnect(); el.removeEventListener("wheel", onWheel); };
  }, [ref, axis, ...deps]); // eslint-disable-line
}
