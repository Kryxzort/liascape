import { useSyncExternalStore } from "react";

// The top bar never wraps from 761 px up (index.css § narrow windows): below these widths its controls fold to their icons,
// the label moving into the aria-label and a tooltip — the sort first (SORT_NARROW), the labelled buttons (Import, Undo, Stop)
// and the background work's words (the count alone, components/TopbarStatus.tsx) later (BUTTONS_NARROW), the search field last
// (SEARCH_NARROW, components/TopbarSearch.tsx). SEARCH_NARROW is what the fullest bar needs with the field at its 120 px
// minimum: Browse with Undo, Stop, Go to selected, the source strip at its 110 px and the Workshop's split (~850 px), the
// Library with Undo, Stop, Go to playing, Import and the status slot's 72 px for a count (~820 px), plus a margin for font
// metrics. The same widths as index.css's media queries. Guard: probe-filters split:noWrap:*, search:fold, search:worst:*
export const SORT_NARROW = "(max-width: 1279.98px)";
export const BUTTONS_NARROW = "(max-width: 999.98px)";
export const SEARCH_NARROW = "(max-width: 859.98px)";
type Tier = typeof SORT_NARROW | typeof BUTTONS_NARROW | typeof SEARCH_NARROW;
const sub = (q: string) => (cb: () => void) => { const m = matchMedia(q); m.addEventListener("change", cb); return () => m.removeEventListener("change", cb); };
const subs = { [SORT_NARROW]: sub(SORT_NARROW), [BUTTONS_NARROW]: sub(BUTTONS_NARROW), [SEARCH_NARROW]: sub(SEARCH_NARROW) };
export const useNarrow = (q: Tier) => useSyncExternalStore(subs[q], () => matchMedia(q).matches);
