import { useSyncExternalStore } from "react";

// The top bar never wraps from 761 px up (index.css § narrow windows): below these widths its controls fold to their icons,
// the label moving into the aria-label and a tooltip — the sort first (SORT_NARROW), the labelled buttons (Import, Undo, Stop)
// later (BUTTONS_NARROW). The same widths as index.css's media queries. Guard: probe-filters split:noWrap:*
export const SORT_NARROW = "(max-width: 1279.98px)";
export const BUTTONS_NARROW = "(max-width: 999.98px)";
const sub = (q: string) => (cb: () => void) => { const m = matchMedia(q); m.addEventListener("change", cb); return () => m.removeEventListener("change", cb); };
const subs = { [SORT_NARROW]: sub(SORT_NARROW), [BUTTONS_NARROW]: sub(BUTTONS_NARROW) };
export const useNarrow = (q: typeof SORT_NARROW | typeof BUTTONS_NARROW) => useSyncExternalStore(subs[q], () => matchMedia(q).matches);
