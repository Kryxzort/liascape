import { useSyncExternalStore } from "react";

// The page URL of the focused card (`browseFocus`) while Browse's shown list holds it, else null. Only Browse knows: it
// filters the loaded pages itself (the "In my library" switch, the local folder's tags), and a new search, sort or source
// replaces the list while the sidebar keeps its last copy of the item. The top bar's locate button reads it to stay disabled
// while there's no card to go to. Browse writes it in a layout effect (the button's state lands in the list's frame) and
// leaves it as it was on unmount: the list and the focus wait in the store, so the button is right from the first frame back.
let shown: string | null = null;
const subs = new Set<() => void>();
const subscribe = (cb: () => void) => { subs.add(cb); return () => { subs.delete(cb); }; };
export function setBrowseFocusShown(pageUrl: string | null) {
  if (pageUrl === shown) return;
  shown = pageUrl;
  for (const cb of subs) cb();
}
export const useBrowseFocusShown = () => useSyncExternalStore(subscribe, () => shown);
