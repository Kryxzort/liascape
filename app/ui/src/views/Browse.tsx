import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import { Card } from "../components/Card";
import { WorkshopFilterBar } from "../components/WorkshopFilterBar";
import { useSmoothScroll } from "../hooks/useSmoothScroll";
import { useGridFit } from "../hooks/useGridFit";
import type { Wallpaper } from "../api/client";

// don't hijack Ctrl+A / Delete etc. while typing in a field
const typing = () => {
  const el = document.activeElement as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
};

// WE-local browse sort menu (client-side over the single loaded page).
function sortBrowse(list: Wallpaper[], idx: number): Wallpaper[] {
  if (idx === 0) return list;
  const a = [...list], t = (x: Wallpaper) => x.title.toLowerCase();
  const d = (x: Wallpaper) => (x.addedAt ? +new Date(x.addedAt) : 0);
  switch (idx) {
    case 1: return a.sort((x, y) => t(x).localeCompare(t(y)));
    case 2: return a.sort((x, y) => t(y).localeCompare(t(x)));
    case 3: return a.sort((x, y) => Number(x.isScene) - Number(y.isScene));
    case 4: return a.sort((x, y) => Number(y.isScene) - Number(x.isScene));
    case 5: return a.sort((x, y) => d(y) - d(x));
    default: return a.sort((x, y) => d(x) - d(y));
  }
}

export function Browse({ onPreview, previewUrl }: { onPreview: (w: Wallpaper) => void; previewUrl: string | null }) {
  const wallpapers = useStore((s) => s.wallpapers);
  const loadMore = useStore((s) => s.loadMore);
  const playingPath = useStore((s) => s.playingPath);
  const downloads = useStore((s) => s.downloads);
  const download = useStore((s) => s.download);
  const cancelDownload = useStore((s) => s.cancelDownload);
  const openExternal = useStore((s) => s.openExternal);
  const hasMore = useStore((s) => s.hasMore);
  const activeSource = useStore((s) => s.activeSource);
  const isWorkshop = useStore((s) => s.isWorkshop());
  const browseSort = useStore((s) => s.browseSort);
  // gate autoplay on window focus/visibility (see App.tsx appActive) → backgrounded = gifs unmount, no decode drain
  const autoPlayGifs = useStore((s) => !!(s.settings?.autoPlayGifs) && s.appActive);
  const sorted = useMemo(() => sortBrowse(wallpapers, browseSort), [wallpapers, browseSort]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const anchor = useRef<string | null>(null);
  useSmoothScroll(scrollRef);
  useGridFit(scrollRef);

  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((e) => { if (e[0].isIntersecting) loadMore(); },
      { root: scrollRef.current, rootMargin: "400px" });
    io.observe(el); // fires an initial callback for the current state → keeps loading if the trigger
                    // is STILL in view after a page lands (re-run on wallpapers.length below)
    return () => io.disconnect();
  }, [loadMore, hasMore, wallpapers.length]);

  // Ctrl+A select-all, Escape clears.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "a" && !typing()) { e.preventDefault(); setSel(new Set(sorted.map((w) => w.pageUrl))); }
      else if (e.key === "Escape" && sel.size) setSel(new Set());
    };
    addEventListener("keydown", h);
    return () => removeEventListener("keydown", h);
  }); // eslint-disable-line

  const onCardClick = (e: React.MouseEvent, w: Wallpaper) => {
    if (e.shiftKey && anchor.current) {
      const ids = sorted.map((x) => x.pageUrl);
      const a = ids.indexOf(anchor.current), b = ids.indexOf(w.pageUrl);
      if (a >= 0 && b >= 0) { const [lo, hi] = a < b ? [a, b] : [b, a]; setSel(new Set(ids.slice(lo, hi + 1))); }
    } else if (e.ctrlKey || e.metaKey) {
      const n = new Set(sel); n.has(w.pageUrl) ? n.delete(w.pageUrl) : n.add(w.pageUrl); setSel(n); anchor.current = w.pageUrl;
    } else { anchor.current = w.pageUrl; download(activeSource, w, true); } // plain left-click → download & apply
  };

  const bulkDownload = () => {
    sorted.filter((w) => sel.has(w.pageUrl)).forEach((w) => download(activeSource, w, false)); // bulk = download without applying
    setSel(new Set());
  };

  // click on the grid background (not a card) clears the selection
  const onBgClick = (e: React.MouseEvent) => {
    const t = e.target as HTMLElement;
    if (sel.size && (t.classList.contains("scroll") || t.classList.contains("grid"))) setSel(new Set());
  };

  return (
    <div className="scroll" ref={scrollRef} onClick={onBgClick}>
      {isWorkshop && <WorkshopFilterBar />}
      {/* no LayoutGroup: layoutId is global, and scoping it here breaks the card→PreviewModal morph
          (the modal renders in App, outside this subtree). */}
      <div className="grid">
          {sorted.map((w) => (
            <Card key={w.pageUrl} w={w} playing={w.pageUrl === playingPath}
              selected={sel.has(w.pageUrl)}
              progress={downloads[w.pageUrl]}
              autoPlayGifs={autoPlayGifs}
              previewing={w.pageUrl === previewUrl}
              onCancel={(x) => cancelDownload(x.pageUrl)}
              onClick={onCardClick}
              onContext={(x) => onPreview(x)} /* right-click → settings / more-info modal */
              onMiddle={(x) => x.pageUrl.startsWith("http") /* middle-click → open source page/location */
                ? openExternal({ url: x.pageUrl })
                : openExternal({ path: x.pageUrl, reveal: true, isScene: x.isScene, workshopId: x.workshopId })} />
          ))}
          {/* INFINITE FEEL: while more pages exist, always render a block of placeholder cards right
              after the real ones (they flow inline, filling the last partial row — no gap). The first
              placeholder is the load trigger: scrolling it toward view fires loadMore, which inserts the
              next page before the block and pushes a fresh batch down. */}
          {hasMore && Array.from({ length: 72 }).map((_, i) => (
            <div className="card lib skel-card" key={`ph${i}`} ref={i === 0 ? sentinel : undefined}>
              <div className="thumb-wrap skel" />
            </div>
          ))}
        </div>

      {sel.size > 0 && (
        <div className="sel-toolbar">
          <span>{sel.size} selected</span>
          <button className="btn accent" onClick={bulkDownload}>Download {sel.size}</button>
          <button className="btn ghost" onClick={() => setSel(new Set())}>Cancel</button>
        </div>
      )}
    </div>
  );
}
