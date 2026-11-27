import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { useStore } from "../store";
import { afterLayout, closeSide, gridGlideMs, openSide, playGrid, snapGrid, type GridSnap } from "../components/sideMotion";

// The item sidebar's open / close for one page (components/sideMotion.ts): the grid's FLIP and the panel's slide. `shown` is
// the page's useLinger of its focus (SidePanel's `closing`). An item switch plays nothing here (SidePanel's carousel); motion
// off nothing at all (the panel fades: index.css :root.no-motion, the cards take their new columns at once).
export function useSideMotion(kind: "library" | "browse", shown: { value: string | null; closing: boolean },
  scrollRef: RefObject<HTMLElement | null>, gridRef: RefObject<HTMLElement | null>, motion: boolean) {
  // FLIP, first half: where the cards are before the focus change renders the dock — read inside the store update, on the
  // click or key that opens or closes it (its layout is clean then), so every caller of focusLib / focusBrowse is covered
  const pending = useRef<GridSnap | null>(null);
  // whether another panel (the filter column) already docked there: then the grid keeps its room and nothing glides
  const roomBefore = useRef(0);
  useEffect(() => {
    if (!motion) return;
    const key = kind === "library" ? "libFocus" : "browseFocus";
    return useStore.subscribe((s, p) => {
      if (s[key] === p[key] || (s[key] && p[key])) return;
      pending.current = snapGrid(gridRef.current);
      roomBefore.current = scrollRef.current ? parseFloat(getComputedStyle(scrollRef.current).marginRight) || 0 : 0;
    });
  }, [kind, gridRef, scrollRef, motion]);

  const last = useRef<{ id: string | null; closing: boolean }>({ id: null, closing: false });
  const docking = useRef(0);
  useLayoutEffect(() => {
    const p = last.current, id = shown.value, closing = shown.closing;
    last.current = { id, closing };
    const what = !id ? null : closing ? (p.closing ? null : "close") : !p.id || p.closing ? "open" : null;
    const snap = pending.current;
    pending.current = null;
    if (!what || !motion) return;
    const sc = scrollRef.current;
    const panel = sc?.parentElement?.querySelector<HTMLElement>(`:scope > .side-panel[data-side="${kind}"]`);
    if (!sc || !panel) return;
    clearTimeout(docking.current);
    if (what === "open") {
      // while the cards glide out from under the opening panel, the grid's scroll box reaches under it (index.css
      // [data-docking]: the same content box, so the same columns) and doesn't clip them; back to its margin once they
      // landed. Not when the filter column held that room already: the grid doesn't change (Guard: probe-filters swap:*)
      if (!roomBefore.current) {
        panel.dataset.docking = "";
        docking.current = window.setTimeout(() => { delete panel.dataset.docking; }, gridGlideMs() + 34);
      }
    }
    // PERF: everything starts in the first frame's own layout pass, not in the click's task: the first Element.animate()
    // there lays out the commit inside the input (a forced layout; Guard: probe-layout perf:sidebar). The frame paints after
    // it, so no frame shows the panel without its motion.
    afterLayout(sc, () => {
      if (what === "open") openSide(panel); else closeSide(panel);
      playGrid(snap, gridRef.current, sc);
    });
  }, [shown.value, shown.closing]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => clearTimeout(docking.current), []);
}
