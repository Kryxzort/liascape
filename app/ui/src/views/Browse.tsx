import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import { Card } from "../components/Card";
import { WorkshopFilterColumn, WorkshopSortRow } from "../components/WorkshopFilterColumn";
import { LIBRARY_TAG, WF_CLOSE_MS, WF_DOCK_MS, useFilterDocked } from "../components/workshopFilter";
import { SidePanel } from "../components/SidePanel";
import { SIDE_CLOSE_MS, useLinger } from "../hooks/useLinger";
import { type MorphSource, morph, snapshot } from "../hooks/filterMorph";
import { BrowseSide } from "../components/BrowseSide";
import { useMotion } from "../components/motion";
import { gridCols, gridOwnsKey, keepCardInView, revealCard, stepIndex } from "../hooks/gridKeys";
import { useSmoothScroll } from "../hooks/useSmoothScroll";
import { useGridFit } from "../hooks/useGridFit";
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
  const isWorkshop = useStore((s) => s.isWorkshop());
  const browseSort = useStore((s) => s.browseSort);
  const browseFocus = useStore((s) => s.browseFocus);
  const focusBrowse = useStore((s) => s.focusBrowse);
  const applyItem = useStore((s) => s.applyItem);
  const motion = useMotion();
  // gate autoplay on window focus/visibility (see App.tsx appActive) → backgrounded = gifs hidden, unpainted: no decode drain
  const autoPlayGifs = useStore((s) => !!(s.settings?.autoPlayGifs) && s.appActive);
  // PERF: one Set per library change; each memo'd card gets a boolean, so only a card whose mark flips re-renders
  const libItems = useStore((s) => s.libraryItems);
  const libKeys = useMemo(() => libraryKeys(libItems), [libItems]);
  // the filter column's "In my library" row (UI-only, workshopFilter.ts LIBRARY_TAG): ✓ = only owned, ✕ = hide owned —
  // filtered here, over the pages already loaded (the infinite-scroll sentinel keeps loading while a page thins out)
  const libMode = useStore((s) => !s.isWorkshop() ? null
    : s.browseFilter.include.includes(LIBRARY_TAG) ? "only" : s.browseFilter.exclude.includes(LIBRARY_TAG) ? "hide" : null);
  const sorted = useMemo(() => {
    const all = sortBrowse(wallpapers, browseSort);
    return libMode ? all.filter((w) => inLibrary(libKeys, w) === (libMode === "only")) : all;
  }, [wallpapers, browseSort, libMode, libKeys]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const anchor = useRef<string | null>(null);
  const smoothRef = useSmoothScroll(scrollRef);
  useGridFit(scrollRef, "browse");

  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((e) => { if (e[0].isIntersecting) loadMore(); },
      { root: scrollRef.current, rootMargin: "400px" });
    io.observe(el); // fires an initial callback for the current state → keeps loading if the trigger
                    // is STILL in view after a page lands (re-run on wallpapers.length below)
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

  // a click focuses (the sidebar shows it) — it never downloads: double-click, Enter or a download button does
  // a pointer focus with the sidebar closed: the card stays where it was while the docked sidebar re-fits the grid (gridKeys.ts)
  const focusFromCard = (pageUrl: string) => {
    if (!useStore.getState().browseFocus) keepCardInView(scrollRef.current, `br-${pageUrl}`);
    focusBrowse(pageUrl);
  };
  const onCardClick = (e: React.MouseEvent, w: Wallpaper) => {
    focusFromCard(w.pageUrl);
    if (e.shiftKey && anchor.current) {
      const ids = sorted.map((x) => x.pageUrl);
      const a = ids.indexOf(anchor.current), b = ids.indexOf(w.pageUrl);
      if (a >= 0 && b >= 0) { const [lo, hi] = a < b ? [a, b] : [b, a]; setSel(new Set(ids.slice(lo, hi + 1))); }
    } else if (e.ctrlKey || e.metaKey) {
      const n = new Set(sel); if (n.has(w.pageUrl)) n.delete(w.pageUrl); else n.add(w.pageUrl); setSel(n); anchor.current = w.pageUrl;
    } else { anchor.current = w.pageUrl; if (sel.size) setSel(new Set()); }
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
  const cardContext = useStableFn((x: Wallpaper) => focusFromCard(x.pageUrl)); // right-click → the sidebar too
  // a drag on the empty space between the cards: box selection into the same `sel` / `anchor` (hooks/useMarquee.ts)
  const onMarquee = useMarquee(scrollRef, { prefix: "br-", sel, setSel, anchor });
  const cardMiddle = useStableFn((x: Wallpaper) => x.pageUrl.startsWith("http") // middle-click → open source page/location
    ? openExternal({ url: x.pageUrl })
    : openExternal({ path: x.pageUrl, reveal: true, isScene: x.isScene, workshopId: x.workshopId }));

  const shown = useLinger(focusedW ? focusedW.pageUrl : null, SIDE_CLOSE_MS, motion);
  // the Workshop filter column: docked from WF_DOCK_QUERY up, a drawer below (the sort row's "Filters · N" opens it)
  const docked = useFilterDocked();
  const colHidden = useStore((s) => s.filterColHidden);
  const setColHidden = useStore((s) => s.setFilterColHidden);
  // COOL: the docked column slides out / back in (WF_DOCK_MS) and the grid glides by its width instead of jumping — the margin
  // flips at once (the grid re-fits once), `.wf-shift-*` plays the offset back to 0 on transform only (n % 2 alternates two
  // identical keyframes so a quick re-toggle restarts it). Only on a toggle: a tab visit / a resize just shows the column.
  const dockCol = useLinger(isWorkshop && docked && !colHidden ? true : null, WF_DOCK_MS, motion);
  const [shift, setShift] = useState<{ dir: "in" | "out"; n: number } | null>(null);
  useEffect(() => { if (!shift) return; const t = setTimeout(() => setShift(null), 420); return () => clearTimeout(t); }, [shift]);
  // the pill ⇄ title morph: snapshot what's being left before the change, fly it onto its counterpart after the commit
  const morphFrom = useRef<MorphSource | null>(null);
  const toggleCol = () => {
    if (motion) {
      morphFrom.current = snapshot(document.querySelector(colHidden ? "[data-wf-open]" : "[data-wf-title]"));
      setShift((s) => ({ dir: colHidden ? "in" : "out", n: (s?.n ?? 0) + 1 }));
    }
    setColHidden(!colHidden);
  };
  useLayoutEffect(() => {
    const from = morphFrom.current; morphFrom.current = null;
    if (from && shift) morph(from, document.querySelector(shift.dir === "in" ? "[data-wf-title]" : "[data-wf-open]"));
  }, [shift]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);
  if (drawerOpen && (docked || !isWorkshop)) setDrawerOpen(false); // follow during render: a wider window / another source
  const drawer = useLinger(isWorkshop && !docked && drawerOpen ? true : null, WF_CLOSE_MS, motion);
  const sideW = shown.value && kept?.pageUrl === shown.value ? kept : null;

  return (
    <>
    {isWorkshop && docked && dockCol.value && <WorkshopFilterColumn mode="dock" closing={dockCol.closing} entering={shift?.dir === "in"} onFold={toggleCol} />}
    <div className={`scroll${shift ? ` wf-shift-${shift.dir}-${shift.n % 2}` : ""}`} ref={smoothRef} onClick={onBgClick} onPointerDown={onMarquee}>
      {isWorkshop && <WorkshopSortRow drawer={!docked} open={docked && !colHidden} onOpenFilters={() => docked ? toggleCol() : setDrawerOpen(true)} />}
      <div className="grid">
          {sorted.map((w) => (
            <Card key={w.pageUrl} w={w} playing={w.pageUrl === playingPath}
              selected={sel.has(w.pageUrl)} focused={w.pageUrl === browseFocus} inLibrary={inLibrary(libKeys, w)}
              progress={downloads[w.pageUrl]}
              autoPlayGifs={autoPlayGifs}
              onCancel={cardCancel} onClick={cardClick} onDownload={cardDownload} onContext={cardContext} onMiddle={cardMiddle} />
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
    {!docked && drawer.value && <WorkshopFilterColumn mode="drawer" closing={drawer.closing} onClose={closeDrawer} />}
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
