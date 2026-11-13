import { memo, useEffect, useMemo, useRef, useState } from "react";
import { filterOf, useStore } from "../store";
import { Card } from "../components/Card";
import { NoMatch, WorkshopFilterColumn } from "../components/WorkshopFilterColumn";
import { LIBRARY_TAG, facetsOf, knownTags, localMatcher, useFilterPanel } from "../components/workshopFilter";
import { SidePanel } from "../components/SidePanel";
import { SIDE_CLOSE_MS, useLinger } from "../hooks/useLinger";
import { BrowseSide } from "../components/BrowseSide";
import { useMotion } from "../components/motion";
import { gridCols, gridOwnsKey, keepCardInView, revealCard, stepIndex } from "../hooks/gridKeys";
import { useSmoothScroll } from "../hooks/useSmoothScroll";
import { useGridFit } from "../hooks/useGridFit";
import { useKeptScroll } from "../hooks/useKeptScroll";
import { useStableFn } from "../hooks/useStableFn";
import { useMarquee } from "../hooks/useMarquee";
// never hijack Ctrl+A / Delete etc. while typing in a field or holding a slider
import { shortcutsBlocked as typing } from "../hooks/rangeDrag";
import type { Wallpaper } from "../api/client";
import { inLibrary, libraryCopy, libraryKeys } from "./libraryMatch";

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

// PERF: memo'd (App passes a stable onShowInLibrary) — App's re-renders don't reach the grid
export const Browse = memo(function Browse({ onShowInLibrary }: { onShowInLibrary: (path: string) => void }) {
  const wallpapers = useStore((s) => s.wallpapers);
  const loadMore = useStore((s) => s.loadMore);
  const playingPath = useStore((s) => s.playingPath);
  const downloads = useStore((s) => s.downloads);
  const download = useStore((s) => s.download);
  const cancelDownload = useStore((s) => s.cancelDownload);
  const openExternal = useStore((s) => s.openExternal);
  const hasMore = useStore((s) => s.hasMore);
  const activeSource = useStore((s) => s.activeSource);
  const browseSort = useStore((s) => s.browseSort);
  const browseFocus = useStore((s) => s.browseFocus);
  const focusBrowse = useStore((s) => s.focusBrowse);
  const applyItem = useStore((s) => s.applyItem);
  const clearTags = useStore((s) => s.clearTags);
  const motion = useMotion();
  // gate autoplay on window focus/visibility (see App.tsx appActive) → backgrounded = gifs hidden, unpainted: no decode drain
  const autoPlayGifs = useStore((s) => !!(s.settings?.autoPlayGifs) && s.appActive);
  // PERF: one Set per library change; each memo'd card gets a boolean, so only a card whose mark flips re-renders
  const libItems = useStore((s) => s.libraryItems);
  const libKeys = useMemo(() => libraryKeys(libItems), [libItems]);
  // the source's filter column: the Workshop's (its tags go to Steam), the local WE folder's (matched here), or none
  const scope = useStore((s) => s.browseScope());
  // the filter column's "In my library" row (UI-only, workshopFilter.ts LIBRARY_TAG): ✓ = only owned, ✕ = hide owned —
  // filtered here, over the pages already loaded (the placeholders keep loading while a page thins out)
  const libMode = useStore((s) => { const sc = s.browseScope(); if (!sc) return null; const f = filterOf(s, sc);
    return f.include.includes(LIBRARY_TAG) ? "only" : f.exclude.includes(LIBRARY_TAG) ? "hide" : null; });
  // the local WE folder holds its whole list: its tags filter it here, no request (workshopFilter.ts localMatcher)
  const weFilter = useStore((s) => s.weFilter);
  const local = scope === "weLocal";
  const match = useMemo(() => (local ? localMatcher(weFilter) : null), [local, weFilter]);
  const known = useMemo(() => (local ? knownTags(wallpapers, (w) => w.pageUrl) : null), [local, wallpapers]);
  const sorted = useMemo(() => {
    let all = sortBrowse(wallpapers, browseSort);
    if (libMode) all = all.filter((w) => inLibrary(libKeys, w) === (libMode === "only"));
    return match ? all.filter((w) => match(facetsOf(w, w.pageUrl))) : all;
  }, [wallpapers, browseSort, libMode, libKeys, match]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const anchor = useRef<string | null>(null);
  const smoothRef = useSmoothScroll(scrollRef);
  useGridFit(scrollRef, "browse");
  // the page is built on each visit (App.tsx): back on it, the list (kept in the store, no request) shows where it was
  // left; another source, search, filter or sort starts at the top. Guard: probe-layout tabs:browse
  const browseFor = useStore((s) => s.browseFor);
  const localView = local ? JSON.stringify([weFilter.include, weFilter.exclude, weFilter.featureMatch, weFilter.genreMatch]) : "";
  useKeptScroll(scrollRef, "browse", `${browseFor}|${libMode}|${browseSort}|${localView}`);

  // any placeholder near the view asks for the next page, not only the first: a jump past it (End, the scrollbar dragged
  // to the bottom) lands among the later ones, and the first would never come into range. Observing fires an initial
  // callback, so the re-run after a page lands keeps loading while placeholders are STILL in range. Guard: probe-layout tabs:browse
  useEffect(() => {
    const sc = scrollRef.current;
    const els = sc ? sc.querySelectorAll(":scope > .grid > .skel-card") : [];
    if (!sc || !els.length) return;
    const io = new IntersectionObserver((e) => { if (e.some((x) => x.isIntersecting)) loadMore(); }, { root: sc, rootMargin: "400px" });
    for (const el of els) io.observe(el);
    return () => io.disconnect();
  }, [loadMore, hasMore, wallpapers.length]);

  // the focused item (a search / sort / filter reload may drop it for a moment: the sidebar keeps the last copy it had)
  const found = browseFocus ? sorted.find((w) => w.pageUrl === browseFocus) ?? null : null;
  const [kept, setKept] = useState<Wallpaper | null>(null);
  if (found && found !== kept) setKept(found); // follow during render
  const focusedW = found ?? (kept && kept.pageUrl === browseFocus ? kept : null);
  const dlApply = (w: Wallpaper) => { const lib = libraryCopy(libItems, w); if (lib) applyItem(lib.videoPath); else download(activeSource, w, true); };

  // Ctrl+A select-all; the grid's keys (hooks/gridKeys.ts): arrows move the focus, Enter downloads & applies the focused
  // card (its library copy if it has one), Escape closes the sidebar + clears the selection.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "a" && !typing()) { e.preventDefault(); setSel(new Set(sorted.map((w) => w.pageUrl))); return; }
      if (!gridOwnsKey(e)) return;
      if (e.key === "Escape") { if (browseFocus || sel.size) { focusBrowse(null); setSel(new Set()); } return; }
      if (e.key === "Enter") { if (focusedW && downloads[focusedW.pageUrl] === undefined) { e.preventDefault(); dlApply(focusedW); } return; }
      const ids = sorted.map((w) => w.pageUrl);
      const j = stepIndex(browseFocus ? ids.indexOf(browseFocus) : -1, e.key, gridCols(scrollRef.current), ids.length);
      if (j == null) return;
      e.preventDefault();
      focusBrowse(ids[j]); revealCard(`br-${ids[j]}`);
    };
    addEventListener("keydown", h);
    return () => removeEventListener("keydown", h);
  });

  // a pointer focus with the sidebar closed: the card stays where it was while the docked sidebar re-fits the grid (gridKeys.ts)
  const focusFromCard = (pageUrl: string) => {
    if (!useStore.getState().browseFocus) keepCardInView(scrollRef.current, `br-${pageUrl}`);
    focusBrowse(pageUrl);
  };
  // a plain click focuses (the sidebar shows it) — it never downloads: double-click, Enter or a download button does; Ctrl /
  // Shift only select, the sidebar stays as it was (docs/decisions.md § "Left click does the tab's main action, right click
  // opens the item sidebar"). Guard: probe-select br:plainClick, br:modClick, br:rightClickSel
  const onCardClick = (e: React.MouseEvent, w: Wallpaper) => {
    if (e.shiftKey && anchor.current) {
      const ids = sorted.map((x) => x.pageUrl);
      const a = ids.indexOf(anchor.current), b = ids.indexOf(w.pageUrl);
      if (a >= 0 && b >= 0) { const [lo, hi] = a < b ? [a, b] : [b, a]; setSel(new Set(ids.slice(lo, hi + 1))); }
    } else if (e.ctrlKey || e.metaKey || e.shiftKey) {
      const n = new Set(sel); if (n.has(w.pageUrl)) n.delete(w.pageUrl); else n.add(w.pageUrl); setSel(n); anchor.current = w.pageUrl;
    } else { focusFromCard(w.pageUrl); anchor.current = w.pageUrl; if (sel.size) setSel(new Set()); }
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

  // PERF: one function per action for every card (each takes its card's wallpaper) — the cards' memo holds when the focus,
  // the selection or a download changes; only the cards whose own props flip re-render. Guard: probe-layout perf:sidebar.
  const cardCancel = useStableFn((x: Wallpaper) => cancelDownload(x.pageUrl));
  const cardClick = useStableFn(onCardClick);
  const cardDownload = useStableFn(dlApply);
  const cardContext = useStableFn((x: Wallpaper) => focusFromCard(x.pageUrl)); // right-click → the sidebar, the selection kept
  // a drag on the empty space between the cards: box selection into the same `sel` / `anchor` (hooks/useMarquee.ts)
  const onMarquee = useMarquee(scrollRef, { prefix: "br-", sel, setSel, anchor });
  const cardMiddle = useStableFn((x: Wallpaper) => x.pageUrl.startsWith("http") // middle-click → open source page/location
    ? openExternal({ url: x.pageUrl })
    : openExternal({ path: x.pageUrl, reveal: true, isScene: x.isScene, workshopId: x.workshopId }));

  const shown = useLinger(focusedW ? focusedW.pageUrl : null, SIDE_CLOSE_MS, motion);
  // the filter panel: docked from WF_DOCK_QUERY up, a drawer below (its toggle is the top bar's split button, App.tsx)
  const col = useFilterPanel("browse", !!scope);
  const sideW = shown.value && kept?.pageUrl === shown.value ? kept : null;

  return (
    <>
    <div className="scroll" ref={smoothRef} onClick={onBgClick} onPointerDown={onMarquee}>
      {match && !sorted.length && wallpapers.length > 0 && <NoMatch onClear={() => clearTags("weLocal")} />}
      <div className="grid">
          {sorted.map((w) => (
            <Card key={w.pageUrl} w={w} playing={w.pageUrl === playingPath}
              selected={sel.has(w.pageUrl)} focused={w.pageUrl === browseFocus} inLibrary={inLibrary(libKeys, w)}
              progress={downloads[w.pageUrl]}
              autoPlayGifs={autoPlayGifs}
              onCancel={cardCancel} onClick={cardClick} onDownload={cardDownload} onContext={cardContext} onMiddle={cardMiddle} />
          ))}
          {/* INFINITE FEEL: while more pages exist, always render a block of placeholder cards right
              after the real ones (they flow inline, filling the last partial row — no gap). They are the
              load trigger: one coming toward view fires loadMore, which inserts the next page before the
              block and pushes a fresh batch down. */}
          {hasMore && Array.from({ length: 72 }).map((_, i) => (
            <div className="card lib skel-card" key={`ph${i}`}>
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
    {/* keyed by scope: another source's column is another list's — its groups fade in fresh (index.css .wf-body) */}
    {scope && col.panel.value && <WorkshopFilterColumn key={scope} mode={col.panel.value} scope={scope} known={known} closing={col.panel.closing} entering={col.entering} onClose={col.close} />}
    {sideW && (
      <SidePanel kind="browse" id={sideW.pageUrl} order={sorted.findIndex((w) => w.pageUrl === sideW.pageUrl)} card={`br-${sideW.pageUrl}`} closing={shown.closing} title={sideW.title} onClose={() => focusBrowse(null)}>
        <BrowseSide w={sideW} source={activeSource} libItem={libraryCopy(libItems, sideW)} progress={downloads[sideW.pageUrl]}
          onDownload={(apply) => download(activeSource, sideW, apply)} onCancel={() => cancelDownload(sideW.pageUrl)}
          onApplyLib={(p) => applyItem(p)} onShowInLibrary={onShowInLibrary}
          onOpenSource={() => sideW.pageUrl.startsWith("http") ? openExternal({ url: sideW.pageUrl })
            : openExternal({ path: sideW.pageUrl, reveal: true, isScene: sideW.isScene, workshopId: sideW.workshopId })} />
      </SidePanel>
    )}
    </>
  );
});
