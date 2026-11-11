import { useEffect, type RefObject } from "react";

// COOL: dock-style magnification driven by the POINTER'S POSITION, not by which item it's on — so the neighbours move
// even while the pointer moves within one playlist item.
//
// Each `.pl-item` gets an amount a ∈ [0, 1] from a bell curve of the distance between the pointer's x and the item's
// resting centre (1 under the pointer, ½ one item pitch away, ~1/16 two away). From it:
//   - magnify: scale 1 + MAG·a from the item's bottom edge (it grows up out of the bar), lifted LIFT·a px — ~15 px of rise
//     in all, inside the gap under the bar's header (no collision with its buttons);
//   - make room: pushed sideways away from the pointer by PUSH·(d/σ)·e^(−d²/2σ²) — a bump that's 0 under the pointer,
//     largest about a pitch away and gone two pitches out, so the neighbours part around the magnified item while far
//     items never move (the row's ends never get pushed out of view);
//   - stacking: the most magnified item on top.
// A spring per item (slightly under-damped: it overshoots a touch and settles — the bounce; critically damped mid-sweep, below) follows a, frame-synced in one
// rAF loop that stops itself once everything rests. The result is written as the `--dock` custom property (one transform);
// dnd-kit owns the inline transform while sorting and React never touches --dock. Distances use the items' LAYOUT boxes
// (offsetLeft, unaffected by transforms), so the motion never feeds back into itself.
// While dragging, everything settles flat. `enabled` false ("Smooth window animations" off / reduced motion) → --dock is
// cleared and the CSS fallback applies (the hovered item alone, 2 px).
const MAG = 0.16;      // the extra scale right under the pointer (1.16× — 1.3× collides with the header)
const LIFT = 4;        // px
const PUSH = 14;       // px — the sideways push's strength (a neighbour moves ~8 px)
const SIGMA = 104;     // px — the bell's width: ½ at one item pitch (122 px)
const REACH = 3 * SIGMA;
const OMEGA = 21;      // rad/s, the spring's natural frequency (~3.3 Hz)
const ZETA = 0.55;     // damping ratio: < 1 → a small overshoot (~12 %) — the bounce
// The bounce only where the eye rests (docs/decisions.md § "Bounce the playlist bar's dock only when entering, stopping or
// leaving" — every item bouncing as the pointer crosses looks stuttery): on entering the row, and on the
// item the pointer settles on (or leaves from). While the pointer moves across, at any speed, the springs are critically
// damped — they follow without overshooting, so the items it passes don't each wobble. The damping changes the spring's force, never its position or velocity, so the hand-over is
// seamless.
const ZETA_GLIDE = 1;
const ENTER_MS = 220;   // the entry window: the first item bounces even if the pointer came in moving
const STILL_MS = 60;    // no pointermove for this long → the pointer has stopped

type Body = { a: number; v: number };

export function useDockLift(rowRef: RefObject<HTMLElement | null>, enabled: boolean, dragging: boolean, deps: unknown[] = []) {
  useEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const items = () => [...row.children] as HTMLElement[];
    const clear = () => { for (const el of items()) { el.style.removeProperty("--dock"); el.style.removeProperty("z-index"); } };
    if (!enabled) { clear(); return; }
    const body = new WeakMap<HTMLElement, Body>();
    let px: number | null = null, raf = 0, last = 0;
    let enteredAt = -Infinity, movedAt = 0;
    // the row reaches up into the bar's head for the magnified items' headroom: a pointer up there counts only on an item
    // (a magnified one), not in the empty space — hovering the header must not magnify the items under it
    const padTop = parseFloat(getComputedStyle(row).paddingTop) || 0;

    const frame = (t: number) => {
      raf = 0;
      const dt = Math.min(last ? t - last : 16, 50) / 1000;
      last = t;
      const els = items();
      // reads first: the pointer in the row's content coordinates, each item's resting centre (layout, not the transform)
      const r = row.getBoundingClientRect();
      const x = px === null ? null : px - r.left - row.clientLeft + row.scrollLeft;
      const centres = els.map((el) => el.offsetLeft + el.offsetWidth / 2);
      const widths = els.map((el) => el.offsetWidth);
      const viewL = row.scrollLeft, viewR = row.scrollLeft + row.clientWidth;
      let moving = false;
      const now = performance.now();
      const sweeping = px !== null && now - enteredAt > ENTER_MS && now - movedAt < STILL_MS;
      const zeta = sweeping ? ZETA_GLIDE : ZETA;
      els.forEach((el, i) => {
        const d = x === null ? Infinity : centres[i] - x;
        const target = x === null || dragging || Math.abs(d) >= REACH ? 0 : Math.exp(-(d * d) / (2 * SIGMA * SIGMA));
        const b = body.get(el) ?? { a: 0, v: 0 };
        // semi-implicit Euler in ≤ 8 ms steps (stable at any frame time)
        for (let left = dt; left > 1e-6; ) {
          const h = Math.min(left, 0.008);
          b.v += (OMEGA * OMEGA * (target - b.a) - 2 * zeta * OMEGA * b.v) * h;
          b.a += b.v * h;
          left -= h;
        }
        if (Math.abs(target - b.a) < 0.001 && Math.abs(b.v) < 0.01) { b.a = target; b.v = 0; } else moving = true;
        body.set(el, b);
        let push = x === null || dragging || Math.abs(d) >= REACH ? 0
          : PUSH * (d / SIGMA) * Math.exp(-(d * d) / (2 * SIGMA * SIGMA)) * Math.min(1, Math.max(0, b.a * 4)); // eases in with the item
        // an item fully on screen at rest stays fully on screen magnified: the first / last one sits at the row's edge, where
        // the push (or its own growth) would cut it off — its magnified box is clamped into the view (nudged inward if need be).
        // One already partly scrolled out is left alone (it mustn't jump in).
        const w = widths[i], half = (w * (1 + MAG * Math.max(0, b.a))) / 2;
        if (centres[i] - w / 2 >= viewL - 0.5 && centres[i] + w / 2 <= viewR + 0.5)
          push = Math.min(Math.max(push, viewL - (centres[i] - half)), viewR - (centres[i] + half));
        if (b.a === 0 && push === 0) { el.style.removeProperty("--dock"); el.style.removeProperty("z-index"); return; }
        el.style.setProperty("--dock", `translate(${push.toFixed(2)}px, ${(-LIFT * b.a).toFixed(2)}px) scale(${(1 + MAG * b.a).toFixed(4)})`);
        el.style.zIndex = String(1 + Math.round(Math.max(0, b.a) * 100));
      });
      row.dispatchEvent(new Event("dockframe")); // the hovered item's glow follows in this same frame (PlaylistBar)
      if (moving) raf = requestAnimationFrame(frame);
      else last = 0; // at rest: the next pointermove / scroll starts it again
    };
    const kick = () => { if (!raf) raf = requestAnimationFrame(frame); };
    const onMove = (e: PointerEvent) => {
      const onItem = !!(e.target as Element | null)?.closest?.(".pl-item");
      const was = px;
      px = onItem || e.clientY >= row.getBoundingClientRect().top + padTop ? e.clientX : null;
      const t = e.timeStamp || performance.now();
      if (px !== null && was === null) enteredAt = t;
      if (px !== null) movedAt = t;
      kick();
    };
    const onLeave = () => { px = null; kick(); };
    row.addEventListener("pointermove", onMove);
    row.addEventListener("pointerleave", onLeave);
    row.addEventListener("scroll", kick, { passive: true }); // the items slide under a still pointer
    kick(); // settle whatever a previous run (a drag, a toggle) left
    return () => {
      row.removeEventListener("pointermove", onMove);
      row.removeEventListener("pointerleave", onLeave);
      row.removeEventListener("scroll", kick);
      cancelAnimationFrame(raf);
    };
  }, [rowRef, enabled, dragging, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
}
