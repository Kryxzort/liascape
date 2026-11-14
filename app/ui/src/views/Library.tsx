import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import { LibraryCard } from "../components/LibraryCard";
import { NoMatch, WorkshopFilterColumn } from "../components/WorkshopFilterColumn";
import { facetsOf, knownTags, localMatcher, useFilterPanel } from "../components/workshopFilter";
import { SidePanel, SelectionNote } from "../components/SidePanel";
import { SIDE_CLOSE_MS, useLinger } from "../hooks/useLinger";
import { LibrarySide } from "../components/LibrarySide";
import { useMotion } from "../components/motion";
import { gridCols, gridOwnsKey, keepCardInView, revealCard, stepIndex } from "../hooks/gridKeys";
import { useSmoothScroll } from "../hooks/useSmoothScroll";
import { useGridFit } from "../hooks/useGridFit";
import { useTravelToPlaying } from "../hooks/travelToPlaying";
import { useStableFn } from "../hooks/useStableFn";
import { useResetOnLeave } from "../hooks/useResetOnLeave";
import { useMarquee } from "../hooks/useMarquee";
// never hijack Ctrl+A / Delete etc. while typing in a field or holding a slider
import { shortcutsBlocked as typing } from "../hooks/rangeDrag";
import type { LibraryItem } from "../api/client";

// library sort options.
function sortItems(items: LibraryItem[], idx: number): LibraryItem[] {
  const a = [...items];
  const t = (x: LibraryItem) => x.title.toLowerCase();
  switch (idx) {
    case 0: return a.sort((x, y) => t(x).localeCompare(t(y)));
    case 1: return a.sort((x, y) => t(y).localeCompare(t(x)));
    case 2: return a.sort((x, y) => Number(x.isScene) - Number(y.isScene));
    case 3: return a.sort((x, y) => Number(y.isScene) - Number(x.isScene));
    case 4: return a.sort((x, y) => +new Date(y.addedAt) - +new Date(x.addedAt));
    default: return a.sort((x, y) => +new Date(x.addedAt) - +new Date(y.addedAt));
  }
}

// PERF: memo'd so App's re-renders (status/modal/etc.) don't cascade into the 300-card grid;
// Library re-renders only when its own store selectors change.
export const Library = memo(function Library() {
  const items = useStore((s) => s.libraryItems);
  const libQuery = useStore((s) => s.libQuery);
  const libSort = useStore((s) => s.libSort);
  const playingPath = useStore((s) => s.playingPath);
  const playlist = useStore((s) => s.playlist);
  const applyItem = useStore((s) => s.applyItem);
  const trashItems = useStore((s) => s.trashItems);
  const toggleInPlaylist = useStore((s) => s.toggleInPlaylist);
  const addManyToPlaylist = useStore((s) => s.addManyToPlaylist);
  const removeManyFromPlaylist = useStore((s) => s.removeManyFromPlaylist);
  const deleteFromSource = useStore((s) => s.deleteFromSource);
  const unsubscribeKeep = useStore((s) => s.unsubscribeKeepWorkshop);
  const openExternal = useStore((s) => s.openExternal);
  const libFocus = useStore((s) => s.libFocus);
  const focusLib = useStore((s) => s.focusLib);
  const keepCurrent = useStore((s) => s.keepCurrent);
  const gVol = useStore((s) => (s.settings?.volume as number) ?? 100);
  const gSpd = useStore((s) => (s.settings?.speed as number) ?? 1);
  const motion = useMotion();
  const setStatus = useStore((s) => s.setStatus);
  const refreshPlayingStatus = useStore((s) => s.refreshPlayingStatus);
  const autoImport = useStore((s) => !!(s.settings?.autoAddWeWallpapersToLibrary));
  // gate autoplay on window focus/visibility (see App.tsx appActive) → backgrounded = gifs hidden, unpainted: no decode drain
  const autoPlayGifs = useStore((s) => !!(s.settings?.autoPlayGifs) && s.appActive);

  const [sel, setSel] = useState<Set<string>>(new Set());
  const anchor = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const smoothRef = useSmoothScroll(scrollRef);
  useGridFit(scrollRef, "library");
  // the filter column: the Library's own filter (store libFilter — never Browse's), matched here against what each item
  // knows (workshopFilter.ts localMatcher); the column offers only the tags some item has
  const libFilter = useStore((s) => s.libFilter);
  const clearTags = useStore((s) => s.clearTags);
  const match = useMemo(() => localMatcher(libFilter), [libFilter]);
  const known = useMemo(() => knownTags(items, (i) => i.videoPath), [items]);
  // the filter panel (its toggle is the top bar's split button, App.tsx)
  const col = useFilterPanel("library", items.length > 0);
  // the page stays mounted across tab switches (App.tsx): leaving it clears the selection (and a drawer: useFilterPanel),
  // its grid stays where it was
  useResetOnLeave(() => { setSel((x) => (x.size ? new Set() : x)); anchor.current = null; });

  // PERF: one predicate per filter change and each item's facets computed once (workshopFilter.ts facetsOf) — no per-card work
  const filtered = useMemo(() => {
    const q = libQuery.trim().toLowerCase();
    let f = q ? items.filter((i) => i.title.toLowerCase().includes(q) || (i.workshopId ?? "").includes(q)) : items;
    if (match) f = f.filter((i) => match(facetsOf(i, i.videoPath)));
    return sortItems(f, libSort);
  }, [items, libQuery, libSort, match]);
  // app open / the first Library visit with something playing: the playing card in view (once per session)
  const showsPlaying = useMemo(() => !!playingPath && filtered.some((i) => i.videoPath === playingPath), [filtered, playingPath]);
  useTravelToPlaying(scrollRef, "library", "y", ".card.playing", playingPath, showsPlaying);
  // a filter change starts the grid at its top, and the selection keeps only what still shows (Delete / a bulk action must
  // never reach a card the user can't see). Keyed on the filter's value: <Activity> re-runs this on every return to the
  // page, which keeps its view. Guard: probe-filters lib:interplay
  const filterKey = JSON.stringify([libFilter.include, libFilter.exclude, libFilter.featureMatch, libFilter.genreMatch]);
  const shownFilter = useRef(filterKey);
  useLayoutEffect(() => {
    if (shownFilter.current === filterKey) return;
    shownFilter.current = filterKey;
    if (scrollRef.current && scrollRef.current.scrollTop > 0) scrollRef.current.scrollTop = 0;
    const vis = new Set(filtered.map((i) => i.videoPath));
    setSel((x) => { const n = new Set([...x].filter((p) => vis.has(p))); return n.size === x.size ? x : n; });
    if (anchor.current && !vis.has(anchor.current)) anchor.current = null;
  }, [filterKey, filtered]);

  const byPath = useMemo(() => Object.fromEntries(items.map((i) => [i.videoPath, i])), [items]);

  // selection status — "{n} selected — {x video, y scene}", reverts to now-playing on clear.
  useEffect(() => {
    if (sel.size) {
      const selItems = [...sel].map((p) => byPath[p]).filter(Boolean);
      const scenes = selItems.filter((i) => i.isScene).length, vids = sel.size - scenes;
      const detail = scenes === 0 ? `${vids} video` : vids === 0 ? `${scenes} scene` : `${vids} video, ${scenes} scene`;
      setStatus(`${sel.size} selected — ${detail}`, false);
    } else {
      refreshPlayingStatus();
    }
    return () => { if (sel.size) refreshPlayingStatus(); }; // clear selection status on unmount/tab switch
  }, [sel]); // eslint-disable-line

  // With auto-import on, a subscribed Workshop item has no plain Delete (the import would bring it back): its Delete is
  // Unsubscribe = Delete from source (undoable; Undo subscribes again), on the card's button, the Delete key and the
  // sidebar alike; a mixed selection unsubscribes those and deletes the rest. The library's own copy of one ("Unsubscribe
  // without deleting") deletes like any local item. Guard: probe-steam side:unsub:*
  const unsubs = (i: LibraryItem) => autoImport && !!i.workshopId && !!i.subscribed;
  const doTrash = (list: LibraryItem[]) => {
    const ws = list.filter(unsubs);
    if (ws.length) deleteFromSource(ws);
    const plain = list.filter((i) => !unsubs(i));
    if (plain.length) trashItems(plain);
    setSel(new Set());
  };
  // "Unsubscribe without deleting" (the Unsubscribe tile's right-click): each subscribed Workshop item becomes the library's
  // own copy, then unsubscribes (POST /workshop/unsubscribe-keep, one at a time); the rest of a selection is left alone
  const doKeep = async (list: LibraryItem[]) => {
    const ws = [...new Map(list.filter(unsubs).map((i) => [i.workshopId!, i])).values()];
    if (!ws.length) return;
    setSel(new Set());
    setStatus(`Keeping ${ws.length === 1 ? ws[0].title : `${ws.length} wallpapers`} in your library…`, false);
    for (const i of ws) await unsubscribeKeep(i.workshopId!, i.title);
    if (ws.length > 1) setStatus(`Unsubscribing ${ws.length} wallpapers — kept in your library`);
  };

  // card actions on a *selected* card repeat to the whole selection.
  const targetsFor = (it: LibraryItem) => (sel.has(it.videoPath) ? [...sel].map((p) => byPath[p]).filter(Boolean) : [it]);
  const doToggle = (it: LibraryItem) => {
    const targets = targetsFor(it).map((i) => i.videoPath);
    if (targets.length > 1) {
      if (playlist.includes(it.videoPath)) removeManyFromPlaylist(targets);
      else addManyToPlaylist(targets);
    } else toggleInPlaylist(it.videoPath);
  };

  // the focus moves (keyboard, the playlist bar's Settings): its card into view
  const focus = (path: string | null, reveal = false) => { focusLib(path); if (path && reveal) revealCard(`lib-${path}`); };
  // the focused item went away (trashed, the library reloaded without it): the sidebar closes
  useEffect(() => { if (libFocus && items.length && !byPath[libFocus]) focusLib(null); }, [libFocus, byPath]); // eslint-disable-line

  // Ctrl+A select-all (filtered), Delete deletes selection — never while typing. The grid's keys (hooks/gridKeys.ts):
  // arrows move the focus (the sidebar follows), Enter plays the focused card, Escape closes the sidebar + clears the selection.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "a" && !typing()) { e.preventDefault(); setSel(new Set(filtered.map((i) => i.videoPath))); return; }
      if (e.key === "Delete" && sel.size && !typing()) { doTrash([...sel].map((p) => byPath[p]).filter(Boolean)); return; }
      if (!gridOwnsKey(e)) return;
      if (e.key === "Escape") { if (libFocus || sel.size) { focusLib(null); setSel(new Set()); } return; }
      if (e.key === "Enter") { if (libFocus && byPath[libFocus]) { e.preventDefault(); applyItem(libFocus); } return; }
      const ids = filtered.map((i) => i.videoPath);
      const from = libFocus ? ids.indexOf(libFocus) : -1;
      let j = stepIndex(from, e.key, gridCols(scrollRef.current), ids.length);
      if (j == null) return; // not an arrow
      // nothing focused yet: the first arrow focuses the playing card (else the first one)
      if (from < 0 && playingPath && ids.includes(playingPath)) j = ids.indexOf(playingPath);
      e.preventDefault();
      focus(ids[j], true);
    };
    addEventListener("keydown", h);
    return () => removeEventListener("keydown", h);
  });

  // a right-click focuses the card (the sidebar shows it): when the sidebar wasn't open, the docked one re-fits the grid's
  // columns — the card stays where it was in the view instead of sliding away from under the pointer (gridKeys.ts keepCardInView)
  const focusFromCard = (path: string) => {
    if (!useStore.getState().libFocus) keepCardInView(scrollRef.current, `lib-${path}`);
    focusLib(path);
  };
  // a plain click applies the card; it never opens the sidebar, but an open one moves to the clicked card (closed stays closed);
  // Ctrl / Shift only select; opening the sidebar is a right-click
  // (docs/decisions.md § "Left click does the tab's main action, right click opens the item sidebar"). Guard: probe-select
  // lib:plainClick, lib:modClick, lib:rightClickSel
  const onCardClick = (it: LibraryItem, e: React.MouseEvent) => {
    if (e.shiftKey && anchor.current) {
      const ids = filtered.map((x) => x.videoPath);
      const a = ids.indexOf(anchor.current), b = ids.indexOf(it.videoPath);
      if (a >= 0 && b >= 0) { const [lo, hi] = a < b ? [a, b] : [b, a]; setSel(new Set(ids.slice(lo, hi + 1))); }
    } else if (e.ctrlKey || e.metaKey || e.shiftKey) {
      const n = new Set(sel); if (n.has(it.videoPath)) n.delete(it.videoPath); else n.add(it.videoPath);
      setSel(n); anchor.current = it.videoPath;
    } else {
      setSel(new Set()); anchor.current = it.videoPath; applyItem(it.videoPath);
      if (useStore.getState().libFocus) focusLib(it.videoPath);
    }
  };

  // click empty grid space clears the selection
  const onBgClick = (e: React.MouseEvent) => {
    const t = e.target as HTMLElement;
    if (sel.size && (t.classList.contains("scroll") || t.classList.contains("grid"))) setSel(new Set());
  };

  // PERF: one function per action for every card (each takes its item) — the cards' memo holds when the focus, the
  // selection or the playing item changes; only the cards whose own props flip re-render. Guard: probe-layout perf:sidebar.
  const cardClick = useStableFn(onCardClick);
  const cardTrash = useStableFn((it: LibraryItem) => doTrash(targetsFor(it)));
  const cardToggle = useStableFn(doToggle);
  const cardContext = useStableFn((it: LibraryItem) => focusFromCard(it.videoPath)); // keeps the selection: the sidebar edits it
  // a drag on the empty space between the cards: box selection into the same `sel` / `anchor` (hooks/useMarquee.ts)
  const onMarquee = useMarquee(scrollRef, { prefix: "lib-", sel, setSel, anchor });

  // the sidebar: the focused item (kept for its exit slide after the focus clears)
  const shown = useLinger(libFocus, SIDE_CLOSE_MS, motion);
  const sideItem = shown.value ? byPath[shown.value] ?? null : null;

  if (items.length === 0) return <div className="center-msg">Library is empty — download wallpapers from Browse.</div>;

  return (
    <>
    <div className="scroll lib-scroll" ref={smoothRef} onClick={onBgClick} onPointerDown={onMarquee}>
      {match && !filtered.length && <NoMatch onClear={() => clearTags("library")} />}
      <div className="grid">
        {filtered.map((it) => (
          <LibraryCard key={it.videoPath} item={it}
            playing={it.videoPath === playingPath}
            selected={sel.has(it.videoPath)}
            focused={it.videoPath === libFocus}
            inPlaylist={playlist.includes(it.videoPath)}
            unsub={unsubs(it)}
            autoPlayGifs={autoPlayGifs}
            onClick={cardClick} onTrash={cardTrash} onToggle={cardToggle} onContextFocus={cardContext} />
        ))}
      </div>
    </div>
    {col.panel.value && <WorkshopFilterColumn mode={col.panel.value} scope="library" known={known} closing={col.panel.closing} entering={col.entering} onClose={col.close} />}
    {sideItem && (() => {
      const targets = targetsFor(sideItem);
      const unsubN = targets.filter(unsubs).length;
      return (
        <SidePanel kind="library" id={sideItem.videoPath} order={filtered.findIndex((i) => i.videoPath === sideItem.videoPath)} card={`lib-${sideItem.videoPath}`} closing={shown.closing} title={sideItem.title}
          sub={<SelectionNote n={targets.length} />} onClose={() => focusLib(null)}>
          <LibrarySide item={sideItem} targets={targets}
            playing={sideItem.videoPath === playingPath} keepCurrent={keepCurrent}
            unsubN={unsubN} deleteN={targets.length - unsubN}
            showDeleteFromSource={!!sideItem.workshopId && !autoImport}
            globalVolume={gVol} globalSpeed={gSpd}
            onPlay={() => applyItem(sideItem.videoPath)}
            onReveal={() => openExternal({ path: sideItem.videoPath, reveal: true, isScene: sideItem.isScene, workshopId: sideItem.workshopId, copiedSceneDir: sideItem.copiedSceneDir })}
            onTrash={() => { focusLib(null); doTrash(targets); }}
            onDeleteSource={() => { focusLib(null); deleteFromSource(targets.filter((i) => i.workshopId)); }}
            onKeep={() => doKeep(targets)} />
        </SidePanel>
      );
    })()}
    </>
  );
});
