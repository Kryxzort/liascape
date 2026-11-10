import { shortcutsBlocked } from "./rangeDrag";

// Keyboard focus in the Library / Browse grids (the WE-style sidebar, 2026-11-10): ← → step one card, ↑ ↓ one row (the
// grid's `--cols`, set by useGridFit), Enter acts on the focused card, Escape closes the sidebar. The grid owns a key only
// when nothing else wants it: no menu / dropdown / modal open, no slider held, and — for arrows and Enter — the key isn't
// aimed at a field or a button (a focused slider in the sidebar steps itself; Enter on a button presses it).
export function gridOwnsKey(e: KeyboardEvent): boolean {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return false;
  if (document.querySelector(".ctx-menu, .sel-pop, .modal-backdrop")) return false;
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
