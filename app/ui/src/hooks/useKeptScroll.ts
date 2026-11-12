import { useLayoutEffect, useRef, type RefObject } from "react";

// The scroll offset of a page App.tsx builds anew on each visit (Browse), kept per page outside React so it outlives the
// page, with the view it was taken on (`view`: what the list shows — its source, search, filters, sort). Coming back
// to the same view brings the offset back; a new view starts at the top, also while the page shows.
const kept = new Map<string, { view: string; top: number }>();

export function useKeptScroll(ref: RefObject<HTMLElement | null>, page: string, view: string) {
  const viewRef = useRef(view);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const k = kept.get(page);
    let ro: ResizeObserver | null = null;
    if (k && k.view === viewRef.current && k.top > 0) {
      // PERF: written in the ResizeObserver's first callback: it runs after the new page's first layout and before that
      // frame paints, so the page shows at its kept offset from its first frame, and the write forces no layout (writing
      // it in this mount effect would lay the whole new page out inside the tab switch). The rows above hold their real
      // height while skipped (index.css `.card`), so the same offset is the same row. Guard: probe-layout tabs:browse, perf:tabs
      ro = new ResizeObserver(() => { ro?.disconnect(); ro = null; if (kept.get(page) === k) el.scrollTop = k.top; });
      ro.observe(el);
    } else kept.set(page, { view: viewRef.current, top: 0 });
    // read as it scrolls (the layout is clean in a scroll event), never on leaving: there the read would force a layout of
    // a document the switch is rebuilding
    const onScroll = () => kept.set(page, { view: viewRef.current, top: el.scrollTop });
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => { ro?.disconnect(); el.removeEventListener("scroll", onScroll); };
  }, [ref, page]);
  // another view: its list starts at the top (written only when the grid isn't there already: the write lays it out)
  useLayoutEffect(() => {
    if (viewRef.current === view) return;
    viewRef.current = view;
    const top = kept.get(page)?.top ?? 0;
    kept.set(page, { view, top: 0 });
    if (top > 0 && ref.current) ref.current.scrollTop = 0;
  }, [ref, page, view]);
}
