// COOL: the magnet — a primary action leans toward a pointer that comes near, before the click (docs/superpowers/specs/
// 2026-11-12-icon-motion-design.md § The magnet). Opt in with `ref={magnetRef}`; only primary actions, never a list's
// items (a grid of leaning buttons is noise). The lean is the element's `translate` (it composes with a hover lift on
// `transform`), eased by CSS (index.css `[data-magnet]`: a quick follow while in range, `--spring-soft` home).
// PERF: written in the pointer's own `pointermove`, never a requestAnimationFrame loop (an idle page asks for no frames —
// Guard: probe-layout perf:idle); rects cached per element, re-read only with the pointer near it, at most every RECT_MS
// and after a scroll / resize. Guard: probe-icons icon:perf.
// Nothing under `:root.no-motion`. Guard: probe-icons icon:magnet, icon:magnet:off.

const REACH = 28;          // px around the box where the pull starts
const MAX_X = 3, MAX_Y = 2; // the most it leans, px
const RECT_MS = 250;
const FAR = 160, FAR_MS = 2000; // px off the cached box past which a move doesn't re-read it (a box at most this old)

type M = { rect: DOMRect | null; at: number; x: number; y: number };
const els = new Map<HTMLElement, M>();
let stale = 0; // bumped by a scroll / resize: every cached rect is re-read

function set(el: HTMLElement, m: M, x: number, y: number) {
  x = Math.round(x * 10) / 10; y = Math.round(y * 10) / 10;
  if (x === m.x && y === m.y) return;
  const on = x !== 0 || y !== 0;
  m.x = x; m.y = y;
  el.toggleAttribute("data-magnet-on", on);
  el.style.translate = on ? `${x}px ${y}px` : "";
}

function move(e: PointerEvent) {
  const off = document.documentElement.classList.contains("no-motion") || e.pointerType === "touch";
  const now = performance.now();
  for (const [el, m] of els) {
    if (off) { set(el, m, 0, 0); continue; }
    // a pointer far from where it was can't be near it: no read (a read can force a layout while one is pending)
    const far = m.rect && m.at >= stale && now - m.at < FAR_MS && Math.max(m.rect.left - e.clientX, e.clientX - m.rect.right, m.rect.top - e.clientY, e.clientY - m.rect.bottom) > FAR;
    if (far) { set(el, m, 0, 0); continue; }
    if (!m.rect || now - m.at > RECT_MS || m.at < stale) {
      // the resting box: the lean itself must not move what it measures
      const r = el.getBoundingClientRect();
      m.rect = new DOMRect(r.x - m.x, r.y - m.y, r.width, r.height); m.at = now;
    }
    const r = m.rect;
    if (!r.width) { set(el, m, 0, 0); continue; }
    const dx = Math.max(r.left - e.clientX, 0, e.clientX - r.right), dy = Math.max(r.top - e.clientY, 0, e.clientY - r.bottom);
    const dist = Math.hypot(dx, dy);
    if (dist >= REACH || (el as HTMLButtonElement).disabled) { set(el, m, 0, 0); continue; }
    const fall = 1 - dist / REACH;
    const nx = Math.max(-1, Math.min(1, (e.clientX - (r.left + r.width / 2)) / (r.width / 2 + REACH)));
    const ny = Math.max(-1, Math.min(1, (e.clientY - (r.top + r.height / 2)) / (r.height / 2 + REACH)));
    set(el, m, nx * MAX_X * fall, ny * MAX_Y * fall);
  }
}
const leave = () => { for (const [el, m] of els) set(el, m, 0, 0); };
const invalidate = () => { stale = performance.now(); };

function bind(on: boolean) {
  const f = on ? addEventListener : removeEventListener;
  f("pointermove", move as EventListener, { passive: true } as AddEventListenerOptions);
  document.documentElement[on ? "addEventListener" : "removeEventListener"]("pointerleave", leave);
  f("scroll", invalidate, { capture: true, passive: true } as AddEventListenerOptions);
  f("resize", invalidate);
}

// a React 19 ref callback (its return value is the cleanup): listening only while a magnet is mounted
export function magnetRef(el: HTMLElement | null) {
  if (!el) return;
  if (els.size === 0) bind(true);
  els.set(el, { rect: null, at: 0, x: 0, y: 0 });
  el.setAttribute("data-magnet", "");
  return () => {
    els.delete(el);
    el.style.translate = "";
    if (els.size === 0) bind(false);
  };
}
