import { useCallback, useEffect, useRef, type RefCallback, type RefObject } from "react";
import { useMotion } from "../components/motion";

// Smooth wheel scrolling: wheel adds velocity; a rAF loop eases the offset with friction decay →
// momentum scrolling (the native Electron scroll is instant). Skips inputs/sliders so spinners keep
// their own wheel behavior.
// Per-tick travel = (added velocity)/(1 - FRICTION) = delta·(IMPULSE/100)/(1-FRICTION). Travel ∝ IMPULSE
// (friction sets the coast duration, IMPULSE the distance): ~1.5× native travel over a ~1.6s glide.
const IMPULSE = 7.5;
const FRICTION = 0.95;     // per 16ms frame — higher = longer glide (travel held via IMPULSE)
const MAX_VELOCITY = 2500;
const STOP = 0.1;

// Only a notched mouse wheel glides; a touchpad (and a hi-res free-spinning wheel) already scrolls in fine steps with its
// own momentum, so it scrolls natively. What Chromium on Linux hands the page (ozone wayland_event_source / events_x_utils,
// blink WheelEvent): a wheel notch is a ui MouseWheelEvent of whole pixels (an integer vector) — 120 per notch
// (wl_pointer value120, X11 buttons 4/5), 180 from a compositor without value120 (15° × 12) — coalesced notches add up; a
// touchpad is a ScrollEvent of fractional pixels (the compositor's 1/256 fixed-point × 12, an X11 valuator × 120), and its
// fling a stream of fractional synthetic wheel events. The page sees deltaY = that value in CSS px at any device scale
// (measured: 120 at devicePixelRatio 1.047), deltaMode always PIXEL, and wheelDeltaY = −ticks·120 = the same number
// (ticks = delta / 120 for both kinds), so wheelDeltaY tells nothing more here.
// So: a whole number of pixels ≥ NOTCH_MIN is a notch; anything else marks a touchpad gesture for PRECISE_HOLD ms, so a
// touchpad event that lands on a whole number mid-gesture doesn't start a glide.
// Limits: a hi-res wheel's sub-notch steps (15 / 30 / 60 px) and a wheel slowed below NOTCH_MIN by a compositor scroll
// factor (or a fractional one) scroll natively; a touchpad gesture whose FIRST event is a whole number ≥ NOTCH_MIN (it
// starts from rest, so its first deltas are small) would glide that one event; a wheel turned within PRECISE_HOLD of a
// touchpad scroll scrolls natively. Guard: probe-layout scroll:glide / scroll:touchpad.
const NOTCH_MIN = 50;
const PRECISE_HOLD = 300;
let preciseUntil = 0; // module-wide: the device is the same whichever scroller it's over
function isNotch(e: WheelEvent, delta: number): boolean {
  if (e.deltaMode !== WheelEvent.DOM_DELTA_PIXEL) return true; // lines / pages: only a wheel reports those
  const px = Math.abs(delta);
  if (px >= NOTCH_MIN && Math.abs(px - Math.round(px)) < 0.01 && e.timeStamp >= preciseUntil) return true;
  if (px < NOTCH_MIN || Math.abs(px - Math.round(px)) >= 0.01) preciseUntil = e.timeStamp + PRECISE_HOLD;
  return false;
}

function bind(el: HTMLElement, axis: "y" | "x", motionOn: () => boolean): () => void {
  let velocity = 0;
  let animating = false;
  let last = 0;

  // PERF: the scroll extent (scrollHeight/scrollWidth) is a *layout-dependent* read. With
  // content-visibility:auto cards toggling visibility mid-scroll, layout is dirty every frame, so
  // reading it inside the rAF loop forced a synchronous reflow 60×/s (self-inflicted scroll jank).
  // Cache `max` and refresh it only on wheel + after a resize — never every frame.
  // PERF: a resize only marks it stale; it's read at the next wheel / glide frame. Reading it at mount or inside the
  // ResizeObserver callback forced a whole-view layout in the middle of a tab switch (the new page's mount effect; the
  // observer runs after another one has already dirtied the layout, e.g. the playlist bar's --playlist-bar-h on :root).
  // Guard: probe-layout perf:tabs.
  let max = 0, stale = true;
  const measure = () => {
    stale = false;
    max = axis === "x"
      ? Math.max(0, el.scrollWidth - el.clientWidth)
      : Math.max(0, el.scrollHeight - el.clientHeight);
  };
  const ro = new ResizeObserver(() => { stale = true; });
  ro.observe(el);
  if (el.firstElementChild) ro.observe(el.firstElementChild); // content grows (LoadMore) → re-measure

  const frame = (t: number) => {
    if (!animating) return;
    const dt = last ? Math.min(t - last, 64) : 16;
    last = t;
    velocity *= Math.pow(FRICTION, dt / 16);
    if (Math.abs(velocity) < STOP) { animating = false; velocity = 0; return; }
    if (stale) measure();
    const cur = axis === "x" ? el.scrollLeft : el.scrollTop;
    const n = Math.min(max, Math.max(0, cur + velocity * (dt / 16)));
    if (n <= 0 || n >= max) velocity = 0; // hit a boundary → kill momentum
    if (axis === "x") el.scrollLeft = n; else el.scrollTop = n;
    requestAnimationFrame(frame);
  };
  const halt = () => { animating = false; velocity = 0; };

  const onWheel = (e: WheelEvent) => {
    if (e.ctrlKey) return; // zoom / pinch: not a scroll
    // let sliders handle their own wheel; a number stepper (components/NumInput.tsx) takes the wheel only while focused
    // and stops it there, so over an unfocused one the page glides on. Guard: probe-expert "stepper: wheel"
    const tgt = e.target as HTMLElement | null;
    if (tgt?.closest("input:not([type=number]),select,textarea,[role=slider]")) return;
    const delta = axis === "x" ? (e.deltaX || e.deltaY) : (e.deltaY || e.deltaX);
    if (!delta) return;
    // motion off (the toggle or prefers-reduced-motion) or a touchpad: the browser scrolls; a running glide yields to it
    // Guard: probe-layout scroll:off / scroll:touchpad
    if (!motionOn() || !isNotch(e, delta)) { halt(); return; }
    e.preventDefault();
    measure(); // user input boundary: re-measure here (cheap, not per-frame) so loadmore growth lands
    velocity = Math.max(-MAX_VELOCITY, Math.min(MAX_VELOCITY, velocity + delta * (IMPULSE / 100)));
    if (!animating) { animating = true; last = 0; requestAnimationFrame(frame); }
  };

  el.addEventListener("wheel", onWheel, { passive: false });
  return () => { halt(); ro.disconnect(); el.removeEventListener("wheel", onWheel); };
}

// Returns the ref to put on the scroll element (it also fills `ref`, for the caller's other hooks). It binds whenever
// that element mounts or changes — a view that first renders a placeholder (the Library while it loads, a dropdown
// before it opens) binds when the real element appears. Guard: probe-layout scroll:bound.
export function useSmoothScroll<T extends HTMLElement>(ref: RefObject<T | null>, axis: "y" | "x" = "y"): RefCallback<T> {
  const motion = useMotion();
  const motionRef = useRef(motion);
  useEffect(() => { motionRef.current = motion; }, [motion]);
  return useCallback((el: T | null) => {
    ref.current = el;
    if (!el) return;
    const unbind = bind(el, axis, () => motionRef.current);
    return () => { unbind(); if (ref.current === el) ref.current = null; };
  }, [ref, axis]);
}
