import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { favoritesUsable, unplayableReasonOf, useStore } from "../store";
import { WsSetLoad } from "../components/WsSetLoad";
import { LibraryCard } from "../components/LibraryCard";
import { NoMatch, WorkshopFilterColumn } from "../components/WorkshopFilterColumn";
import { facetsOf } from "../components/facets";
import { knownTags, localMatcher, useFilterPanel } from "../components/workshopFilter";
import { SidePanel, SelectionNote } from "../components/SidePanel";
import { SIDE_CLOSE_MS, useLinger } from "../hooks/useLinger";
import { ItemSide } from "../components/ItemSide";
import { useRemoval } from "../components/itemRemoval";
import { useMotion } from "../components/motion";
import { gridCols, gridOwnsKey, keepCardInView, revealCard, stepIndex } from "../hooks/gridKeys";
import { useSmoothScroll } from "../hooks/useSmoothScroll";
import { useGridFit } from "../hooks/useGridFit";
import { useTravelToPlaying } from "../hooks/travelToPlaying";
import { useStableFn } from "../hooks/useStableFn";
import { useResetOnLeave } from "../hooks/useResetOnLeave";
import { useMarquee } from "../hooks/useMarquee";
import { usePresence } from "../hooks/usePresence";
// never hijack Ctrl+A / Delete etc. while typing in a field or holding a slider
import { shortcutsBlocked as typing } from "../hooks/rangeDrag";
import type { LibraryItem } from "../api/client";
import { setPreviewOrder, setPreviewSide } from "../components/previewQueue";
import { CRASHED_TAG, HIDDEN_TAG, byFavorites, setModesOf } from "./localSet";
import { Welcome } from "../components/Welcome";
import { Tip } from "../components/Tip";

const keyOfItem = (i: LibraryItem) => i.videoPath;
// the welcome's leave over the grid coming in (index.css `.welcome.leaving`); motion off a fade (useLinger: FADE_EXIT_MS)
const WELCOME_OUT_MS = 260;
// how long the side coming in by a welcome / grid swap keeps its `entering` class (its animation's length and a little)
const SWAP_IN_MS = 700;

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
// PERF: memo'd (App passes a stable onShowInBrowse) — App's re-renders don't reach the grid
export const Library = memo(function Library({ onShowInBrowse }: { onShowInBrowse: () => void }) {
  const items = useStore((s) => s.libraryItems);
  const libQuery = useStore((s) => s.libQuery);
  const setLibQuery = useStore((s) => s.setLibQuery);
  const libraryRead = useStore((s) => s.libraryRead);
  const welcomeOpen = useStore((s) => s.welcomeOpen);
  const libSort = useStore((s) => s.libSort);
  const playingPath = useStore((s) => s.playingPath);
  const playlist = useStore((s) => s.playlist);
  const applyItem = useStore((s) => s.applyItem);
  const toggleInPlaylist = useStore((s) => s.toggleInPlaylist);
  const addManyToPlaylist = useStore((s) => s.addManyToPlaylist);
  const removeManyFromPlaylist = useStore((s) => s.removeManyFromPlaylist);
  const libFocus = useStore((s) => s.libFocus);
  const focusLib = useStore((s) => s.focusLib);
  const motion = useMotion();
  const setStatus = useStore((s) => s.setStatus);
  const refreshPlayingStatus = useStore((s) => s.refreshPlayingStatus);
  // every scene and preset is greyed while the scene renderer is missing (store unplayableReasonOf): one flag here, a
  // reason per card
  const scenesBlocked = useStore((s) => s.scenesBlocked);
  const reasonOf = useMemo(() => (i: LibraryItem) => unplayableReasonOf(i, scenesBlocked), [scenesBlocked]);

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
  const known = useMemo(() => {
    const k = knownTags(items, (i) => i.videoPath);
    if (items.some((i) => i.hasCrashed)) k.add(CRASHED_TAG);
    return k;
  }, [items]);
  // The Crashed row: ✓ keeps the items whose scene crashed the player, ✕ the rest. Guard: probe-filters lib:crashed
  const crashMode = libFilter.include.includes(CRASHED_TAG) ? "inc" : libFilter.exclude.includes(CRASHED_TAG) ? "exc" : null;
  // The hidden cards (the sidebar's Hide; store hidden): left out of the grid; the Hidden row's ✓ shows only them, with
  // Unhide in their sidebar. Guard: probe-hidden hide:lib, hide:filter
  const hiddenLib = useStore((s) => s.hidden.library);
  const hidOnly = libFilter.include.includes(HIDDEN_TAG);
  // The Favourites row: ✓ keeps the items starred on the Workshop, ✕ the rest (a non-Workshop item is never starred). Signed
  // out (or Steam turning the account down) it means nothing. While the list isn't read yet (unread, loading with none in, or a
  // failed read with none in) the whole Library shows under the load line / error with Retry (WsSetLoad, as in Browse): never an
  // empty grid for an error, never a silent no-op. The same rule as Browse's (views/localSet.ts byFavorites); the Library's own
  // sort and search apply on top, and no Steam paging. Guard: probe-steam lib:yours:fav, lib:yours:load, lib:yours:error
  const favMode = useStore((s) => setModesOf(s.libFilter, favoritesUsable(s.steam)).fav);
  const favIds = useStore((s) => {
    const f = s.wsFavs;
    return f?.signedIn && !((f.error || f.loading) && !f.items.length) ? f.ids : null;
  });
  const loadFavorites = useStore((s) => s.loadFavorites);
  useEffect(() => { if (favMode !== null) loadFavorites("open"); }, [favMode, loadFavorites]);
  const favSet = favMode !== null ? favIds : null;
  // the filter panel (its toggle is the top bar's split button, App.tsx)
  const col = useFilterPanel("library", items.length > 0);
  // the page stays mounted across tab switches (App.tsx): leaving it clears the selection (and a drawer: useFilterPanel),
  // its grid stays where it was
  useResetOnLeave(() => { setSel((x) => (x.size ? new Set() : x)); anchor.current = null; });
  // a card picked from outside the grid (store pickLib: the "go to playing" crosshairs) replaces the selection like a plain
  // click on it: the selection cleared, the range anchor on it. Compared with the last pick seen, since <Activity> re-runs
  // effects on every return to the page. Guard: probe-sidebar lib:locateSelect
  const libPick = useStore((s) => s.libPick);
  const seenPick = useRef(libPick);
  useEffect(() => {
    if (seenPick.current === libPick) return;
    seenPick.current = libPick;
    setSel((x) => (x.size ? new Set() : x)); anchor.current = useStore.getState().libFocus;
  }, [libPick]);

  // PERF: one predicate per filter change and each item's facets computed once (components/facets.ts facetsOf) — no per-card work
  const filtered = useMemo(() => {
    const q = libQuery.trim().toLowerCase();
    let f = items.filter((i) => !!hiddenLib[i.videoPath] === hidOnly);
    if (q) f = f.filter((i) => i.title.toLowerCase().includes(q) || (i.workshopId ?? "").includes(q));
    if (match) f = f.filter((i) => match(facetsOf(i, i.videoPath)));
    if (favSet) f = byFavorites(f, favMode, favSet, (i) => i.workshopId);
    if (crashMode) f = f.filter((i) => !!i.hasCrashed === (crashMode === "inc"));
    return sortItems(f, libSort);
  }, [items, libQuery, libSort, match, favSet, favMode, crashMode, hiddenLib, hidOnly]);
  // the marked items while the Crashed row is on: a mark lifted (the sidebar's Clear, Housekeeping's) narrows the selection
  // like a star does under Favourites
  const crashSig = useMemo(() => (crashMode ? items.filter((i) => i.hasCrashed).map((i) => i.videoPath).join("\n") : ""), [items, crashMode]);
  // app open / the first Library visit with something playing: the playing card in view (once per session)
  const showsPlaying = useMemo(() => !!playingPath && filtered.some((i) => i.videoPath === playingPath), [filtered, playingPath]);
  useTravelToPlaying(scrollRef, "library", "y", ".card.playing", playingPath, showsPlaying);
  // a filter change starts the grid at its top, and the selection keeps only what still shows (Delete / a bulk action must
  // never reach a card the user can't see). Keyed on the filter's value: <Activity> re-runs this on every return to the
  // page, which keeps its view. Guard: probe-filters lib:interplay
  const filterKey = JSON.stringify([libFilter.include, libFilter.exclude, libFilter.featureMatch, libFilter.genreMatch]);
  // a star that comes or goes while the Favourites row is on narrows the selection the same way, the grid keeping its place.
  // Guard: probe-steam lib:yours:fav
  // a card hidden or shown again (a Hide, an Undo, an Unhide) narrows it the same way. Guard: probe-hidden hide:lib
  const shownFilter = useRef(filterKey), shownFavs = useRef(favSet), shownCrash = useRef(crashSig), shownHidden = useRef(hiddenLib);
  useLayoutEffect(() => {
    const filterChanged = shownFilter.current !== filterKey;
    if (!filterChanged && shownFavs.current === favSet && shownCrash.current === crashSig && shownHidden.current === hiddenLib) return;
    shownFilter.current = filterKey; shownFavs.current = favSet; shownCrash.current = crashSig; shownHidden.current = hiddenLib;
    if (filterChanged && scrollRef.current && scrollRef.current.scrollTop > 0) scrollRef.current.scrollTop = 0;
    const vis = new Set(filtered.map((i) => i.videoPath));
    setSel((x) => { const n = new Set([...x].filter((p) => vis.has(p))); return n.size === x.size ? x : n; });
    if (anchor.current && !vis.has(anchor.current)) anchor.current = null;
  }, [filterKey, favSet, crashSig, hiddenLib, filtered]);

  // the grid's cards leave and join in motion: a delete, an unsubscribe, a filter or search, and Undo bringing one back
  // (hooks/usePresence.ts; a card still leaving renders in its old place, everything else reads `filtered`). After the filter's
  // scroll reset above: its layout effect runs first. Guard: probe-presence lib:*
  const gridRef = useRef<HTMLDivElement>(null);
  const { list: gridItems } = usePresence(filtered, keyOfItem, gridRef, motion);

  const byPath = useMemo(() => Object.fromEntries(items.map((i) => [i.videoPath, i])), [items]);

  // The welcome (components/Welcome.tsx) in the grid's place: while the library is empty, or asked for from Settings. A swap
  // either way cross-fades: the welcome leaves over the grid coming in, or comes in where the grid was (motion on it rises a
  // little; off, opacity alone). Each side's `entering` class is set only by a swap, so <Activity> showing the page again
  // replays nothing. The last card a delete takes finishes leaving first (its presence list empty), then the welcome comes.
  // Guard: --probe probe-firstrun.js welcome:*, motion:welcome
  const welcomeWanted = libraryRead && ((items.length === 0 && gridItems.length === 0) || welcomeOpen);
  const welcome = useLinger(welcomeWanted ? "welcome" : null, WELCOME_OUT_MS, motion);
  const [swap, setSwap] = useState<{ wanted: boolean; entering: "welcome" | "grid" | null }>({ wanted: welcomeWanted, entering: null });
  if (swap.wanted !== welcomeWanted) setSwap({ wanted: welcomeWanted, entering: welcomeWanted ? "welcome" : "grid" });
  useEffect(() => {
    if (!swap.entering) return;
    const t = setTimeout(() => setSwap((x) => ({ ...x, entering: null })), SWAP_IN_MS);
    return () => clearTimeout(t);
  }, [swap.entering]);
  // the grid showing nothing: what is empty, said with what fills it or the way back. Hidden ✓ with nothing hidden and
  // Favourites ✓ with no favourite at all teach how to fill them; a search alone says what it looked for; every wallpaper
  // hidden says where they are
  const emptyKind = filtered.length || !items.length ? null
    : hidOnly && !items.some((i) => hiddenLib[i.videoPath]) ? "hidden"
    : favMode === "inc" && favSet && favSet.size === 0 ? "favourites"
    : match || favSet || crashMode || hidOnly ? "filters" : libQuery.trim() ? "search"
    : items.every((i) => hiddenLib[i.videoPath]) ? "allHidden" : null;
  // the order the backend makes the cards' missing previews in: the sidebar's item, the cards on screen, then this
  // (components/previewQueue.ts)
  useEffect(() => setPreviewOrder(filtered.map((i) => i.videoPath)), [filtered]);
  useEffect(() => setPreviewSide(libFocus), [libFocus]);

  // selection status — "3 selected: 2 videos, 1 scene", reverts to now-playing on clear.
  useEffect(() => {
    if (sel.size) {
      const selItems = [...sel].map((p) => byPath[p]).filter(Boolean);
      const scenes = selItems.filter((i) => i.isScene).length, vids = sel.size - scenes;
      const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
      const detail = scenes === 0 ? count(vids, "video") : vids === 0 ? count(scenes, "scene") : `${count(vids, "video")}, ${count(scenes, "scene")}`;
      setStatus(`${sel.size} selected: ${detail}`, false);
    } else {
      refreshPlayingStatus();
    }
    return () => { if (sel.size) refreshPlayingStatus(); }; // clear selection status on unmount/tab switch
  }, [sel]); // eslint-disable-line

  // the library's removals (components/itemRemoval.ts): the card's button, the Delete key and the sidebar alike
  const { unsubs, unsubOff, doTrash } = useRemoval(() => setSel(new Set()));

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
      // the welcome stands in the grid's place: no key reaches cards the user can't see
      if (welcomeWanted) return;
      if ((e.ctrlKey || e.metaKey) && e.key === "a" && !typing()) { e.preventDefault(); setSel(new Set(filtered.map((i) => i.videoPath))); return; }
      if (e.key === "Delete" && sel.size && !typing() && !document.querySelector(".modal-backdrop")) { doTrash([...sel].map((p) => byPath[p]).filter(Boolean)); return; }
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
  // a right-click: the sidebar on the card (the selection kept: the sidebar edits it); no menu (docs/decisions.md § "One
  // sidebar for an item, the same on both tabs")
  const cardContext = useStableFn((it: LibraryItem) => focusFromCard(it.videoPath));
  // the sidebar's Hide / Unhide act on the selection when the card is in it, else on the card: a hidden card leaves the grid
  // (the top bar's Undo brings it back) and the sidebar on it closes. Guard: probe-hidden hide:lib, hide:multi, hide:filter
  const hideCards = useStore((s) => s.hideCards), unhideCards = useStore((s) => s.unhideCards);
  const hideFor = (it: LibraryItem) => {
    const list = targetsFor(it);
    const done = () => { focusLib(null); setSel(new Set()); };
    return {
      hidden: !!hiddenLib[it.videoPath], n: list.length,
      onHide: () => { done(); hideCards("library", list.map((i) => ({ key: i.videoPath, title: i.title }))); },
      onUnhide: () => { done(); unhideCards("library", list.map((i) => i.videoPath), list.map((i) => i.title)); },
    };
  };
  // a drag on the empty space between the cards: box selection into the same `sel` / `anchor` (hooks/useMarquee.ts)
  const onMarquee = useMarquee(scrollRef, { prefix: "lib-", sel, setSel, anchor });

  // the sidebar: the focused item (kept for its exit slide after the focus clears)
  const shown = useLinger(libFocus, SIDE_CLOSE_MS, motion);
  const sideItem = shown.value ? byPath[shown.value] ?? null : null;

  // nothing read yet: an empty page, never the welcome for a library that is only on its way
  if (!libraryRead && items.length === 0) return null;

  return (
    <>
    <div className={`scroll lib-scroll${welcome.value ? " has-welcome" : ""}`} ref={smoothRef} onClick={onBgClick} onPointerDown={welcomeWanted ? undefined : onMarquee}>
      {welcome.value && <Welcome empty={items.length === 0} entering={swap.entering === "welcome"} leaving={welcome.closing} />}
      {!welcomeWanted && <>
      <WsSetLoad scope="library" />
      {emptyKind === "favourites" && <NoMatch kind="favourites" text="No favourites yet. Star a Workshop wallpaper in its sidebar (right-click its card) and it shows here." onClear={() => clearTags("library")} />}
      {emptyKind === "hidden" && <NoMatch kind="hidden" text="Nothing is hidden. A wallpaper you hide (Hide in its sidebar) leaves the grid and shows here." onClear={() => clearTags("library")} />}
      {emptyKind === "filters" && <NoMatch onClear={() => clearTags("library")} />}
      {emptyKind === "search" && <NoMatch kind="search" text={`Nothing in your library matches “${libQuery.trim()}”.`} clear="Clear search" onClear={() => setLibQuery("")} />}
      {emptyKind === "allHidden" && <NoMatch kind="allHidden" text="Every wallpaper here is hidden. The filter's Hidden row shows them." clear={null} onClear={() => {}} />}
      {/* the item sidebar and what it holds are a right-click away: said once, above the cards. Guard: --probe probe-firstrun.js
          tip:cardMenu */}
      <Tip id="cardMenu" when={filtered.length > 0}>Right-click a wallpaper to open its sidebar: settings, Hide and more.</Tip>
      <div className={`grid${swap.entering === "grid" ? " swap-in" : ""}`} ref={gridRef}>
        {gridItems.map((it) => (
          <LibraryCard key={it.videoPath} item={it}
            playing={it.videoPath === playingPath}
            selected={sel.has(it.videoPath)}
            focused={it.videoPath === libFocus}
            inPlaylist={playlist.includes(it.videoPath)}
            unsub={unsubs(it)} unsubOff={unsubs(it) ? unsubOff : null} reason={reasonOf(it)}
            onClick={cardClick} onTrash={cardTrash} onToggle={cardToggle} onContextFocus={cardContext} />
        ))}
      </div>
      </>}
    </div>
    {col.panel.value && !welcomeWanted && <WorkshopFilterColumn mode={col.panel.value} scope="library" known={known} closing={col.panel.closing} entering={col.entering} onClose={col.close} />}
    {sideItem && !welcomeWanted && (() => {
      const targets = targetsFor(sideItem);
      return (
        <SidePanel kind="library" id={sideItem.videoPath} order={filtered.findIndex((i) => i.videoPath === sideItem.videoPath)} card={`lib-${sideItem.videoPath}`} closing={shown.closing} title={sideItem.title}
          sub={<SelectionNote n={targets.length} />} onClose={() => focusLib(null)}>
          <ItemSide tab="library" w={null} lib={sideItem} libTargets={targets} hide={hideFor(sideItem)}
            clearSel={() => setSel(new Set())} onRemoved={() => focusLib(null)}
            onShowInBrowse={onShowInBrowse} onShowInLibrary={(path) => { focusLib(path); revealCard(`lib-${path}`); }} />
        </SidePanel>
      );
    })()}
    </>
  );
});
