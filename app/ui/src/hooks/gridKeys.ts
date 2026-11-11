import { shortcutsBlocked } from "./rangeDrag";

// Keyboard focus in the Library / Browse grids (the WE-style sidebar): ← → step one card, ↑ ↓ one row (the
// grid's `--cols`, set by useGridFit), Enter acts on the focused card, Escape closes the sidebar. The grid owns a key only
// when nothing else wants it: no dropdown / modal open, no slider held, and — for arrows and Enter — the key isn't
// aimed at a field or a button (a focused slider in the sidebar steps itself; Enter on a button presses it).
export function gridOwnsKey(e: KeyboardEvent): boolean {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return false;
  if (document.querySelector(".sel-pop, .modal-backdrop")) return false;
  if (e.key === "Escape") return !shortcutsBlocked() || !(e.target as HTMLElement | null)?.closest?.("input, textarea");
  if (shortcutsBlocked()) return false;
  const t = e.target as HTMLElement | null;
  return !t?.closest?.("input, textarea, select, button, a, [contenteditable], .sel");
}

// the index the key moves to (clamped to the list), or null for a key that isn't a move
export function stepIndex(i: number, key: string, cols: number, n: number): number | null {
  const d = key === "ArrowRight" ? 1 : key === "ArrowLeft" ? -1 : key === "ArrowDown" ? cols : key === "ArrowUp" ? -cols : 0;
  if (!d || n === 0) return null;
  if (i < 0) return 0;
  const j = i + d;
  return j < 0 || j >= n ? i : j;
}

export const gridCols = (el: HTMLElement | null) => (el ? +getComputedStyle(el).getPropertyValue("--cols") || 1 : 1);

// the focused card into view (nearest edge, no glide) — after the docked sidebar re-fitted the grid (two frames)
export function revealCard(morphId: string) {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    document.querySelector(`[data-morph-id="${CSS.escape(morphId)}"]`)?.closest(".card")?.scrollIntoView({ block: "nearest" });
  }));
}

// A card the pointer just focused (a click / right-click) while the sidebar was closed: the docked sidebar opens and the grid
// re-fits its columns (`useGridFit` — a frame or two later), which moved the card — often out of view, from under the pointer.
// Keep its top where it was in the scroll view for the next ~12 frames (the re-fit lands within them), then make sure it's
// whole in view. A wheel / pointer-down in the list hands the scroll back to the user.
export function keepCardInView(sc: HTMLElement | null, morphId: string) {
  const find = () => document.querySelector(`[data-morph-id="${CSS.escape(morphId)}"]`)?.closest<HTMLElement>(".card") ?? null;
  const c0 = find();
  if (!sc || !c0) return;
  const top0 = c0.getBoundingClientRect().top - sc.getBoundingClientRect().top;
  let n = 0, raf = 0, stopped = false;
  const stop = () => { stopped = true; cancelAnimationFrame(raf); sc.removeEventListener("wheel", stop); sc.removeEventListener("pointerdown", stop); };
  const step = () => {
    if (stopped) return;
    const c = find();
    if (!c) { stop(); return; }
    const s = sc.getBoundingClientRect(), r = c.getBoundingClientRect();
    const d = r.top - s.top - top0;
    if (Math.abs(d) > 0.5) sc.scrollTop += d;
    if (++n < 12) { raf = requestAnimationFrame(step); return; }
    stop();
    const r2 = c.getBoundingClientRect();
    if (r2.top < s.top || r2.bottom > s.bottom) c.scrollIntoView({ block: "nearest" });
  };
  sc.addEventListener("wheel", stop, { passive: true });
  sc.addEventListener("pointerdown", stop);
  raf = requestAnimationFrame(step);
}
