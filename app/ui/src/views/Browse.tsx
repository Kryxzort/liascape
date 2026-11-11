import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import { Card } from "../components/Card";
import { WorkshopFilterBar } from "../components/WorkshopFilterBar";
import { SidePanel } from "../components/SidePanel";
import { SIDE_CLOSE_MS, useLinger } from "../hooks/useLinger";
import { BrowseSide } from "../components/BrowseSide";
import { useMotion } from "../components/motion";
import { gridCols, gridOwnsKey, keepCardInView, revealCard, stepIndex } from "../hooks/gridKeys";
import { useSmoothScroll } from "../hooks/useSmoothScroll";
import { useGridFit } from "../hooks/useGridFit";
// never hijack Ctrl+A / Delete etc. while typing in a field or holding a slider
import { shortcutsBlocked as typing } from "../hooks/rangeDrag";
import type { LibraryItem, Wallpaper } from "../api/client";

// "Mark the wallpapers already downloaded" (owner todo 2026-11-10): what of a Browse list the library already holds — by
// its Workshop id (Workshop + the WE-local folder: the same item under either source), else by the page it came from
// (moewalls / motionbgs / desktophut downloads keep it as `pageUrl`; `sourceId` is the source URL too).
export function libraryKeys(items: LibraryItem[]): Set<string> {
  const k = new Set<string>();
  for (const i of items) {
    if (i.workshopId) k.add("ws:" + i.workshopId);
    for (const u of [i.pageUrl, i.sourceId, i.videoPath]) if (u) k.add("url:" + u);
  }
  return k;
}
export const inLibrary = (keys: Set<string>, w: Wallpaper) =>
  (!!w.workshopId && keys.has("ws:" + w.workshopId)) || keys.has("url:" + w.pageUrl);
// the library's copy of a Browse item (same rule as inLibrary) — the sidebar's Apply / Show in Library
export const libraryCopy = (items: LibraryItem[], w: Wallpaper) =>
  items.find((i) => (!!w.workshopId && i.workshopId === w.workshopId) || [i.pageUrl, i.sourceId, i.videoPath].includes(w.pageUrl)) ?? null;

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

export function Browse({ onShowInLibrary }: { onShowInLibrary: (path: string) => void }) {
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
  // gate autoplay on window focus/visibility (see App.tsx appActive) → backgrounded = gifs unmount, no decode drain
  const autoPlayGifs = useStore((s) => !!(s.settings?.autoPlayGifs) && s.appActive);
  const sorted = useMemo(() => sortBrowse(wallpapers, browseSort), [wallpapers, browseSort]);
  // PERF: one Set per library change; each memo'd card gets a boolean, so only a card whose mark flips re-renders
  const libItems = useStore((s) => s.libraryItems);
  const libKeys = useMemo(() => libraryKeys(libItems), [libItems]);
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
  }); // eslint-disable-line

  // a click focuses (the sidebar shows it) — it no longer downloads: double-click, Enter or a download button does
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
      const n = new Set(sel); n.has(w.pageUrl) ? n.delete(w.pageUrl) : n.add(w.pageUrl); setSel(n); anchor.current = w.pageUrl;
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

  const shown = useLinger(focusedW ? focusedW.pageUrl : null, SIDE_CLOSE_MS, motion);
  const sideW = shown.value && kept?.pageUrl === shown.value ? kept : null;

  return (
    <>
    <div className="scroll" ref={scrollRef} onClick={onBgClick}>
      {isWorkshop && <WorkshopFilterBar />}
      <div className="grid">
          {sorted.map((w) => (
            <Card key={w.pageUrl} w={w} playing={w.pageUrl === playingPath}
              selected={sel.has(w.pageUrl)} focused={w.pageUrl === browseFocus} inLibrary={inLibrary(libKeys, w)}
              progress={downloads[w.pageUrl]}
              autoPlayGifs={autoPlayGifs}
              onCancel={(x) => cancelDownload(x.pageUrl)}
              onClick={onCardClick}
              onDownload={dlApply}
              onContext={(x) => focusFromCard(x.pageUrl)} /* right-click → the sidebar too */
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
}
