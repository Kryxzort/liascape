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

// the card's layout top in its scroll view (its offset parents: the grid, then the scroll box, both positioned) — not its
// drawn box: a card gliding to new columns as the sidebar opens (components/sideMotion.ts) is drawn where it was
// (index.css `.scroll` and `.grid` are position: relative); NaN when the chain misses the scroll box
function topIn(sc: HTMLElement, c: HTMLElement) {
  let y = 0, e: HTMLElement | null = c;
  for (; e && e !== sc; e = e.offsetParent as HTMLElement | null) y += e.offsetTop;
  return e === sc ? y - sc.scrollTop : NaN;
}
// scroll the least that shows the card whole
function showWhole(sc: HTMLElement, c: HTMLElement) {
  const t = topIn(sc, c), b = t + c.offsetHeight;
  if (Number.isNaN(t)) { c.scrollIntoView({ block: "nearest" }); return; }
  if (t < 0) sc.scrollTop += t;
  else if (b > sc.clientHeight) sc.scrollTop += Math.min(t, b - sc.clientHeight);
}

// the focused card into view (nearest edge, no glide) — after the docked sidebar re-fitted the grid (two frames)
export function revealCard(morphId: string) {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const c = document.querySelector(`[data-morph-id="${CSS.escape(morphId)}"]`)?.closest<HTMLElement>(".card");
    const sc = c?.closest<HTMLElement>(".scroll");
    if (c?.offsetParent && sc) showWhole(sc, c); // (no offset parent: its page is hidden)
  }));
}

// A card the pointer just focused (a right-click, Browse's plain click) while the sidebar was closed: the docked sidebar opens
// and the grid re-fits its columns (`useGridFit`), which moved the card — often out of view, from under the pointer.
// Keep its row's top where it was in the scroll view: first in the frame of the re-fit (a ResizeObserver delivers after
// useGridFit's, which is older, and before the sidebar's glide reads where the cards landed: components/sideMotion.ts
// afterLayout), then for the next ~12 frames; then make sure it's whole in view. Read from layout (offsetTop), not the drawn
// box: the card glides to its new place on `translate` meanwhile, and its drawn box would make this scroll chase the glide.
// A wheel / pointer-down in the list hands the scroll back to the user. Guard: probe-sidebar lib:reflow
export function keepCardInView(sc: HTMLElement | null, morphId: string) {
  const find = () => document.querySelector(`[data-morph-id="${CSS.escape(morphId)}"]`)?.closest<HTMLElement>(".card") ?? null;
  const c0 = find();
  if (!sc || !c0) return;
  const top0 = topIn(sc, c0);
  let n = 0, raf = 0, stopped = false;
  const ro = new ResizeObserver(() => { ro.disconnect(); step(); });
  const stop = () => { stopped = true; ro.disconnect(); cancelAnimationFrame(raf); sc.removeEventListener("wheel", stop); sc.removeEventListener("pointerdown", stop); };
  function step() {
    if (stopped) return;
    const c = find();
    if (!c) { stop(); return; }
    const d = topIn(sc!, c) - top0;
    if (Math.abs(d) > 0.5) sc!.scrollTop += d;
    if (++n < 12) { cancelAnimationFrame(raf); raf = requestAnimationFrame(step); return; }
    stop();
    showWhole(sc!, c);
  }
  sc.addEventListener("wheel", stop, { passive: true });
  sc.addEventListener("pointerdown", stop);
  ro.observe(sc);
}
