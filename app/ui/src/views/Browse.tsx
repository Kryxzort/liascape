import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { PRESET_TAG, browseRequestKey, filterOf, hiddenOnSource, presetsOn, useStore } from "../store";
import { Card } from "../components/Card";
import { NoMatch, WorkshopFilterColumn } from "../components/WorkshopFilterColumn";
import { facetsOf } from "../components/facets";
import { WF_GROUPS, knownTags, localMatcher, useFilterPanel } from "../components/workshopFilter";
import { SidePanel, SelectionNote } from "../components/SidePanel";
import { SIDE_CLOSE_MS, useLinger } from "../hooks/useLinger";
import { useSideMotion } from "../hooks/useSideMotion";
import { ItemSide } from "../components/ItemSide";
import { WsListNote } from "../components/WorkshopSocial";
import { WsSetLoad } from "../components/WsSetLoad";
import { useMotion } from "../components/motion";
import { firstPreview, useHoverOrder, useIdleOrder } from "../components/mediaAssets";
import { gridCols, gridOwnsKey, keepCardInView, revealCard, stepIndex } from "../hooks/gridKeys";
import { useSmoothScroll } from "../hooks/useSmoothScroll";
import { useGridFit } from "../hooks/useGridFit";
import { useKeptScroll } from "../hooks/useKeptScroll";
import { useStableFn } from "../hooks/useStableFn";
import { useMarquee } from "../hooks/useMarquee";
import { setBrowseFocusShown } from "../hooks/useBrowseFocusShown";
import { usePresence } from "../hooks/usePresence";
// never hijack Ctrl+A / Delete etc. while typing in a field or holding a slider
import { shortcutsBlocked as typing } from "../hooks/rangeDrag";
import type { LibraryItem, Wallpaper, WorkshopFilter } from "../api/client";
import { inLibrary, libraryCopy, libraryKeys } from "./libraryMatch";
import { FAVORITES_TAG, HIDDEN_TAG, LIBRARY_TAG, buildLocalSet, byFavorites, effectiveLocalSort, hideSets, isLocalSet, libraryCards } from "./localSet";
import { actionBlocked, isWorkshopItem, subscribeIsDownload } from "../components/subscribeMode";

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

// a scene's presets list ignores Type, as the Workshop does for it (the backend's WorkshopTags.ForPresets): every item is a preset
const TYPE_TAGS = new Set(WF_GROUPS.find((g) => g.id === "type")!.subs[0].tags.map((t) => t.tag).concat(PRESET_TAG));
const withoutType = (f: WorkshopFilter): WorkshopFilter =>
  ({ ...f, include: f.include.filter((t) => !TYPE_TAGS.has(t)), exclude: f.exclude.filter((t) => !TYPE_TAGS.has(t)) });
const NO_IDS = new Set<string>();
const keyOfWallpaper = (w: Wallpaper) => w.pageUrl;
// the favourites' count check while Browse shows (the backend asks Steam at most every 50 s of these)
const FAV_CHECK_MS = 60_000;
const isYours = (t: string) => t === LIBRARY_TAG || t === FAVORITES_TAG;

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
  // Settings → "On hover" / "Not hovered": a result shows its gif or its still image (no video before it's downloaded). Not
  // hovered, nothing plays while the window is inactive (App.tsx appActive): no decode drain behind other windows.
  const gifOnHover = firstPreview(useHoverOrder(), { video: false, gif: true }) === "gif";
  const gifIdle = firstPreview(useIdleOrder(), { video: false, gif: true }) === "gif";
  // PERF: one Set per library change; each memo'd card gets a boolean, so only a card whose mark flips re-renders
  const libItems = useStore((s) => s.libraryItems);
  const libKeys = useMemo(() => libraryKeys(libItems), [libItems]);
  // the source's filter column: the Workshop's (its tags go to Steam), the local WE folder's (matched here), or none
  const scope = useStore((s) => s.browseScope());
  // the local WE folder's "In my library" row: ✓ = only owned, ✕ = hide owned, filtered here over what it holds
  const libMode = useStore((s) => { if (s.browseScope() !== "weLocal") return null; const f = s.weFilter;
    return f.include.includes(LIBRARY_TAG) ? "only" : f.exclude.includes(LIBRARY_TAG) ? "hide" : null; });
  // the local WE folder holds its whole list: its tags filter it here, no request (workshopFilter.ts localMatcher)
  const weFilter = useStore((s) => s.weFilter);
  const local = scope === "weLocal";
  const match = useMemo(() => (local ? localMatcher(weFilter) : null), [local, weFilter]);
  // the Workshop's Yours rows (views/localSet.ts): a ✓ shows the set itself — the favourites, the library's Workshop items —
  // with the filter, the search and its own sort applied here; ✕ alone takes the set out of the Workshop's pages
  const ws = scope === "workshop";
  const modes = useStore(useShallow((s) => s.setModes()));
  const setOn = ws && isLocalSet(modes);
  const favs = useStore((s) => s.wsFavs);
  const libDetails = useStore((s) => s.wsLibDetails);
  const browseFilter = useStore((s) => s.browseFilter);
  const wsList = useStore((s) => s.wsList);
  const query = useStore((s) => s.query);
  const localSort = useStore((s) => effectiveLocalSort(s.localSort, s.setModes().lib === "inc"));
  const scenesOn = useStore((s) => !!s.settings?.allowScenes);
  const presetsCan = useStore((s) => presetsOn(s.settings));
  const loadLibDetails = useStore((s) => s.loadLibDetails);
  const loadFavorites = useStore((s) => s.loadFavorites);
  const setBrowseFilter = useStore((s) => s.setBrowseFilter);
  const setQuery = useStore((s) => s.setQuery);
  const appActive = useStore((s) => s.appActive);
  // Browse showing the Workshop with a Favourites row ✓ / ✕ (its sign-in usable): the id diff when it opens, or when the row,
  // the sign-in or the source brings it (sync=open, shared with a row's own in the store), then the count check about once a
  // minute while it shows and the window is active; no other timed refresh. Guard: probe-steam yours:check, yours:oneOpen
  const favOn = ws && modes.fav !== null;
  useEffect(() => { if (favOn) loadFavorites("open"); }, [favOn, loadFavorites]);
  useEffect(() => {
    if (!favOn || !appActive) return;
    const t = setInterval(() => loadFavorites("check"), FAV_CHECK_MS);
    return () => clearInterval(t);
  }, [favOn, appActive, loadFavorites]);
  const libCards = useMemo(() => (setOn && modes.lib ? libraryCards(libItems, libDetails) : []), [setOn, modes.lib, libItems, libDetails]);
  const libAdded = useMemo(() => new Map(libItems.flatMap((i) => (i.workshopId ? [[i.workshopId, Date.parse(i.addedAt)] as const] : []))), [libItems]);
  const setMatch = useMemo(() => (ws ? localMatcher(wsList?.kind === "presets" ? withoutType(browseFilter) : browseFilter) : null), [ws, wsList, browseFilter]);
  // the library's new Workshop items get their details while In my library ✓ shows them (only the ones not held yet)
  useEffect(() => { if (setOn && modes.lib === "inc") loadLibDetails(); }, [setOn, modes.lib, libItems, loadLibDetails]);
  // The source's hidden cards (the sidebar's Hide; store hidden, by page URL and source): left out of every list it shows;
  // the Hidden row's ✓ shows only them, from the cards kept with them (no request: store reload), narrowed by the search, the
  // tags and the other Yours rows. Guard: probe-hidden hide:browse, hide:filter, hide:web
  const srcName = useStore((s) => s.sources[s.activeSource]?.name);
  const hiddenAll = useStore((s) => s.hidden.browse);
  const hiddenHere = useMemo(() => hiddenOnSource({ library: {}, browse: hiddenAll }, srcName), [hiddenAll, srcName]);
  const hidOn = useStore((s) => s.hiddenViewOn());
  const hiddenCards = useMemo(() => {
    if (!hidOn) return [];
    const q = query.trim().toLowerCase();
    let l = Object.values(hiddenHere).flatMap((e) => (e.card ? [e.card] : []));
    if (q) l = l.filter((w) => w.title.toLowerCase().includes(q) || (w.workshopId ?? "").includes(q));
    const m = ws ? setMatch : match;
    if (m) l = l.filter((w) => m(facetsOf(w, w.pageUrl)));
    if (ws) {
      l = hideSets(l, modes, favs?.ids ?? NO_IDS, libKeys);
      if (modes.lib === "inc") l = l.filter((w) => inLibrary(libKeys, w));
      if (modes.fav === "inc") l = byFavorites(l, "inc", favs?.ids ?? NO_IDS, (w) => w.workshopId);
    }
    if (libMode) l = l.filter((w) => inLibrary(libKeys, w) === (libMode === "only"));
    return sortBrowse(l, ws ? 0 : browseSort);
  }, [hidOn, hiddenHere, query, ws, setMatch, match, modes, favs, libKeys, libMode, browseSort]);
  const listed = useMemo(() => {
    if (setOn) return buildLocalSet({ modes, favs: favs?.items ?? [], lib: libCards, libAdded, list: wsList, query, match: setMatch, scenesOn,
      presetsOn: presetsCan, presetTicked: browseFilter.include.includes(PRESET_TAG), sort: localSort });
    let all = sortBrowse(wallpapers, browseSort);
    if (ws) all = hideSets(all, modes, favs?.ids ?? NO_IDS, libKeys);
    if (libMode) all = all.filter((w) => inLibrary(libKeys, w) === (libMode === "only"));
    return match ? all.filter((w) => match(facetsOf(w, w.pageUrl))) : all;
  }, [setOn, modes, favs, libCards, libAdded, wsList, query, setMatch, scenesOn, presetsCan, browseFilter, localSort, wallpapers, browseSort, ws, libKeys, libMode, match]);
  // the local WE folder's column offers the tags its items know: the hidden ones' while the Hidden row shows them
  const known = useMemo(() => (!local ? null : knownTags(hidOn ? Object.values(hiddenHere).flatMap((e) => (e.card ? [e.card] : [])) : wallpapers, (w) => w.pageUrl)),
    [local, hidOn, hiddenHere, wallpapers]);
  const sorted = useMemo(() => (hidOn ? hiddenCards : Object.keys(hiddenHere).length ? listed.filter((w) => !hiddenHere[w.pageUrl]) : listed),
    [hidOn, hiddenCards, hiddenHere, listed]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const anchor = useRef<string | null>(null);
  const smoothRef = useSmoothScroll(scrollRef);
  useGridFit(scrollRef, "browse");
  // the page is built on each visit (App.tsx): back on it, the list (kept in the store, no request) shows where it was
  // left; another source, search, filter or sort starts at the top. Guard: probe-layout tabs:browse
  const browseFor = useStore((s) => s.browseFor);
  const localView = local ? JSON.stringify([weFilter.include, weFilter.exclude, weFilter.featureMatch, weFilter.genreMatch])
    : setOn ? JSON.stringify([browseFilter.include, browseFilter.exclude, browseFilter.featureMatch, browseFilter.genreMatch, query, localSort, wsList && [wsList.kind, "id" in wsList ? wsList.id : null]])
    : ws ? JSON.stringify(modes) : "";
  // the Hidden view of a source is its own view: its search and filter start it at the top like any list's
  const scopeFilter = useStore((s) => (scope ? filterOf(s, scope) : null));
  const hiddenView = hidOn ? JSON.stringify([srcName, query, scopeFilter?.include, scopeFilter?.exclude, scopeFilter?.featureMatch, scopeFilter?.genreMatch]) : "";
  useKeptScroll(scrollRef, "browse", `${browseFor}|${libMode}|${browseSort}|${localView}|${hiddenView}`);
  // the grid's cards leave and join in motion: a filter, a search, a set's star or library mark, a list replaced (another
  // source: the old cards fade as the new come). The page's first list just shows. After useKeptScroll: its layout effect
  // puts a new view at the top before this one reads where the cards went. Guard: probe-presence browse:filter
  const gridRef = useRef<HTMLDivElement>(null);
  const { list: gridItems } = usePresence(sorted, keyOfWallpaper, gridRef, motion);

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
  // (or an item the list doesn't hold, shown on purpose: a preset's base scene, store showBrowseItem)
  const extra = useStore((s) => s.browseExtra);
  const found = browseFocus ? sorted.find((w) => w.pageUrl === browseFocus) ?? (extra?.pageUrl === browseFocus ? extra : null) : null;
  const [kept, setKept] = useState<Wallpaper | null>(null);
  if (found && found !== kept) setKept(found); // follow during render
  const focusedW = found ?? (kept && kept.pageUrl === browseFocus ? kept : null);
  // the top bar's locate button (components/LocateButton.tsx BrowseLocate) goes to the focused card only while the list
  // shows it; before paint, so the button never shows a frame in the old state
  const focusShown = found && found !== extra ? found.pageUrl : null;
  useLayoutEffect(() => setBrowseFocusShown(focusShown), [focusShown]);
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

  // a selection of Workshop items in the merged mode subscribes (components/subscribeMode.ts)
  const bulkSub = useStore((s) => subscribeIsDownload(s.settings)) && sel.size > 0 && sorted.some((w) => sel.has(w.pageUrl) && isWorkshopItem(w));
  // a download the mode can't do now (components/subscribeMode.ts actionBlocked): a selection of only such items disables the
  // button with the reason; a mixed one downloads the rest. Guard: probe-steam side:blocked:download
  const getOff = useStore((s) => actionBlocked(s.settings, s.steam, "download"));
  const selItems = sorted.filter((w) => sel.has(w.pageUrl));
  const bulkOff = getOff && selItems.length > 0 && selItems.every(isWorkshopItem) ? getOff : null;
  const bulkDownload = () => {
    if (bulkOff) return;
    selItems.filter((w) => !getOff || !isWorkshopItem(w)).forEach((w) => download(activeSource, w, false)); // bulk = download without applying
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
  // a right-click: the sidebar (the selection kept); no menu (docs/decisions.md § "One sidebar for an item, the same on
  // both tabs")
  const cardContext = useStableFn((x: Wallpaper) => focusFromCard(x.pageUrl));
  // The sidebar acts on the selection when its card is in it, else on the card (as the Library's does): Hide / Unhide every
  // card; the library copies' volume, speed and removal. Guard: probe-hidden hide:browse, hide:multi, same:*
  const hideCards = useStore((s) => s.hideCards), unhideCards = useStore((s) => s.unhideCards);
  const setTagState = useStore((s) => s.setTagState);
  // a selection the search or a filter took off the grid leaves the shown card alone
  const sideTargets = (w: Wallpaper) => {
    const shown = sel.has(w.pageUrl) ? sorted.filter((x) => sel.has(x.pageUrl)) : [];
    return shown.length ? shown : [w];
  };
  const hideFor = (w: Wallpaper, list: Wallpaper[]) => {
    const done = () => { focusBrowse(null); setSel(new Set()); };
    return {
      hidden: !!hiddenHere[w.pageUrl], n: list.length,
      onHide: () => { done(); hideCards("browse", list.map((x) => ({ key: x.pageUrl, title: x.title, card: x }))); },
      onUnhide: () => { done(); unhideCards("browse", list.map((x) => x.pageUrl), list.map((x) => x.title)); },
    };
  };
  // a drag on the empty space between the cards: box selection into the same `sel` / `anchor` (hooks/useMarquee.ts)
  const onMarquee = useMarquee(scrollRef, { prefix: "br-", sel, setSel, anchor });
  const cardMiddle = useStableFn((x: Wallpaper) => x.pageUrl.startsWith("http") // middle-click → open source page/location
    ? openExternal({ url: x.pageUrl })
    : openExternal({ path: x.pageUrl, reveal: true, isScene: x.isScene, workshopId: x.workshopId }));

  // a local set nothing in it matches (inside a creator's or a scene's presets list too, where the list's own note stays
  // hidden): say so, with a way out that clears the search and the other tags but never the Yours rows, the set itself. Not
  // while the favourites are still coming or couldn't be read: the load line speaks then. A presets list ignores the Type
  // tags (withoutType), so they neither count as a filter to clear there nor get cleared. Guard: probe-steam yours:empty
  const setEmpty = !hidOn && setOn && !sorted.length && !(modes.fav === "inc" && (!favs || !!favs.loading || !!favs.error));
  const stays = (t: string) => isYours(t) || (wsList?.kind === "presets" && TYPE_TAGS.has(t));
  const others = browseFilter.include.some((t) => !stays(t)) || browseFilter.exclude.some((t) => !stays(t));
  const setClear = query && others ? "Clear search and filters" : query ? "Clear search" : others ? "Clear filters" : null;
  const clearOthers = () => {
    if (others) setBrowseFilter({ include: browseFilter.include.filter(stays), exclude: browseFilter.exclude.filter(stays) });
    if (query) setQuery("");
  };

  // Favourites ✓ with no favourite at all: how to star one, in place of "Nothing here matches"
  const noFavs = modes.fav === "inc" && !!favs && !favs.loading && !favs.error && favs.ids.size === 0;
  // a source that answered nothing for what is asked now (not a list or a set: they say so themselves; not an empty list a
  // failed or pending request left from an earlier ask: browseFor names the request the list answers): what it holds and how it
  // fills, or what was searched with the way back. Guard: --probe probe-firstrun.js empty:browse
  const srcLabel = srcName ?? "This source";
  const sourceEmpty = useStore((s) => !s.loading && !s.hasMore && s.browseFor !== "" && s.browseFor === browseRequestKey(s))
    && !setOn && !wsList && !wallpapers.length;
  const wsFiltered = ws && (browseFilter.include.length > 0 || browseFilter.exclude.length > 0);
  const empty = !sourceEmpty ? null
    : query ? { kind: "search", text: `Nothing on ${srcLabel} matches “${query}”.`, clear: "Clear search", onClear: () => setQuery("") }
    : local ? { kind: "weLocal", text: "Your Wallpaper Engine folder has no wallpapers yet. Subscribe to some on the Workshop and they show up here.", clear: null, onClear: () => {} }
    : wsFiltered ? { kind: "filters", text: "No Workshop wallpapers match these filters.", clear: "Clear filters", onClear: () => clearTags("workshop") }
    : { kind: "source", text: `${srcLabel} has nothing to show right now. Try again in a while.`, clear: null, onClear: () => {} };

  const shown = useLinger(focusedW ? focusedW.pageUrl : null, SIDE_CLOSE_MS, motion);
  useSideMotion("browse", shown, scrollRef, gridRef, motion); // the open / close slide and the grid's glide
  // the filter panel: docked from WF_DOCK_QUERY up, a drawer below (its toggle is the top bar's split button, App.tsx)
  const col = useFilterPanel("browse", !!scope);
  const sideW = shown.value && kept?.pageUrl === shown.value ? kept : null;

  return (
    <>
    <div className="scroll br-scroll" ref={smoothRef} onClick={onBgClick} onPointerDown={onMarquee}>
      {ws && <WsSetLoad />}
      {match && !sorted.length && wallpapers.length > 0 && <NoMatch onClear={() => clearTags("weLocal")} />}
      {setEmpty && <NoMatch kind="set" text={noFavs ? "No favourites yet. Star a Workshop wallpaper in its sidebar and it shows here." : "Nothing here matches"} clear={setClear} onClear={clearOthers} />}
      {/* the Hidden row's ✓ with nothing (left) to show: say so, with the way back to the list. Guard: probe-hidden hide:filter */}
      {hidOn && !sorted.length && scope && <NoMatch kind="hidden" text="Nothing hidden here. A wallpaper you hide (Hide in its sidebar) leaves the list and shows here." clear="Show the list" onClear={() => setTagState(HIDDEN_TAG, null, scope)} />}
      {empty && !hidOn && <NoMatch kind={`browse-${empty.kind}`} text={empty.text} clear={empty.clear} onClear={empty.onClear} />}
      <WsListNote />
      <div className="grid" ref={gridRef}>
          {gridItems.map((w) => (
            <Card key={w.pageUrl} w={w} playing={w.pageUrl === playingPath}
              selected={sel.has(w.pageUrl)} focused={w.pageUrl === browseFocus} inLibrary={inLibrary(libKeys, w)}
              progress={downloads[w.pageUrl]}
              gifOnHover={gifOnHover} gifIdle={gifIdle}
              onCancel={cardCancel} onClick={cardClick} onDownload={cardDownload} onContext={cardContext} onMiddle={cardMiddle} />
          ))}
          {/* INFINITE FEEL: while more pages exist, always render a block of placeholder cards right
              after the real ones (they flow inline, filling the last partial row — no gap). They are the
              load trigger: one coming toward view fires loadMore, which inserts the next page before the
              block and pushes a fresh batch down. */}
          {/* a local set shows whole: no placeholders even over a hasMore the set's own reload hasn't cleared yet */}
          {hasMore && !setOn && !hidOn && Array.from({ length: 72 }).map((_, i) => (
            <div className="card lib skel-card" key={`ph${i}`}>
              <div className="thumb-wrap skel" />
            </div>
          ))}
        </div>

      {sel.size > 0 && (
        <div className="sel-toolbar">
          <span>{sel.size} selected</span>
          <button className="btn accent" onClick={bulkDownload} aria-disabled={bulkOff ? true : undefined} title={bulkOff ?? undefined}>{bulkSub ? "Subscribe" : "Download"} {sel.size}</button>
          <button className="btn ghost" onClick={() => setSel(new Set())}>Cancel</button>
        </div>
      )}
    </div>
    {/* keyed by scope: another source's column is another list's — its groups fade in fresh (index.css .wf-body) */}
    {scope && col.panel.value && <WorkshopFilterColumn key={scope} mode={col.panel.value} scope={scope} known={known} closing={col.panel.closing} entering={col.entering} onClose={col.close} />}
    {sideW && (() => {
      const list = sideTargets(sideW);
      const lib = libraryCopy(libItems, sideW);
      const libTargets = [...new Set(list.map((x) => (x === sideW ? lib : libraryCopy(libItems, x))).filter((x) => !!x))] as LibraryItem[];
      return (
        <SidePanel kind="browse" id={sideW.pageUrl} order={sorted.findIndex((w) => w.pageUrl === sideW.pageUrl)} card={`br-${sideW.pageUrl}`} closing={shown.closing} title={sideW.title}
          sub={<SelectionNote n={list.length} />} onClose={() => focusBrowse(null)}>
          <ItemSide tab="browse" w={sideW} lib={lib} libTargets={lib ? [lib, ...libTargets.filter((x) => x !== lib)] : []} hide={hideFor(sideW, list)}
            clearSel={() => setSel(new Set())} onRemoved={() => {}} onShowInBrowse={() => {}} onShowInLibrary={onShowInLibrary} />
        </SidePanel>
      );
    })()}
    </>
  );
});
