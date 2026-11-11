import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import { LibraryCard } from "../components/LibraryCard";
import { SidePanel, SelectionNote } from "../components/SidePanel";
import { SIDE_CLOSE_MS, useLinger } from "../hooks/useLinger";
import { LibrarySide } from "../components/LibrarySide";
import { useMotion } from "../components/motion";
import { gridCols, gridOwnsKey, keepCardInView, revealCard, stepIndex } from "../hooks/gridKeys";
import { useSmoothScroll } from "../hooks/useSmoothScroll";
import { useGridFit } from "../hooks/useGridFit";
import { useTravelToPlaying } from "../hooks/travelToPlaying";
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
  // gate autoplay on window focus/visibility (see App.tsx appActive) → backgrounded = gifs unmount, no decode drain
  const autoPlayGifs = useStore((s) => !!(s.settings?.autoPlayGifs) && s.appActive);

  const [sel, setSel] = useState<Set<string>>(new Set());
  const anchor = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  useSmoothScroll(scrollRef);
  useGridFit(scrollRef);
  // app open / the first Library visit with something playing: the playing card in view (once per session)
  useTravelToPlaying(scrollRef, "library", "y", ".card.playing", playingPath, items.length);

  const filtered = useMemo(() => {
    const q = libQuery.trim().toLowerCase();
    const f = q ? items.filter((i) => i.title.toLowerCase().includes(q) || (i.workshopId ?? "").includes(q)) : items;
    return sortItems(f, libSort);
  }, [items, libQuery, libSort]);

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

  // when AutoImport is on, deleting a workshop item = delete-from-source (else it's re-imported).
  const doTrash = (list: LibraryItem[]) => {
    const ws = list.filter((i) => i.workshopId);
    if (autoImport && ws.length) deleteFromSource(ws);
    const plain = autoImport ? list.filter((i) => !i.workshopId) : list;
    if (plain.length) trashItems(plain);
    setSel(new Set());
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
  }); // eslint-disable-line

  // a pointer focus (a click, a right-click): when the sidebar wasn't open, the docked one re-fits the grid's columns — the card
  // stays where it was in the view instead of sliding away from under the pointer (gridKeys.ts keepCardInView)
  const focusFromCard = (path: string) => {
    if (!useStore.getState().libFocus) keepCardInView(scrollRef.current, `lib-${path}`);
    focusLib(path);
  };
  // a click focuses the card (the sidebar shows it) — a plain click also applies it, as before (and as WE does); a right-click
  // (LibraryCard) focuses it without applying (owner 2026-11-11: "no context menu anywhere")
  const onCardClick = (it: LibraryItem, e: React.MouseEvent) => {
    focusFromCard(it.videoPath);
    if (e.shiftKey && anchor.current) {
      const ids = filtered.map((x) => x.videoPath);
      const a = ids.indexOf(anchor.current), b = ids.indexOf(it.videoPath);
      if (a >= 0 && b >= 0) { const [lo, hi] = a < b ? [a, b] : [b, a]; setSel(new Set(ids.slice(lo, hi + 1))); }
    } else if (e.ctrlKey || e.metaKey) {
      const n = new Set(sel); n.has(it.videoPath) ? n.delete(it.videoPath) : n.add(it.videoPath);
      setSel(n); anchor.current = it.videoPath;
    } else { setSel(new Set()); anchor.current = it.videoPath; applyItem(it.videoPath); }
  };

  // click empty grid space clears the selection
  const onBgClick = (e: React.MouseEvent) => {
    const t = e.target as HTMLElement;
    if (sel.size && (t.classList.contains("scroll") || t.classList.contains("grid"))) setSel(new Set());
  };

  // the sidebar: the focused item (kept for its exit slide after the focus clears)
  const shown = useLinger(libFocus, SIDE_CLOSE_MS, motion);
  const sideItem = shown.value ? byPath[shown.value] ?? null : null;

  if (items.length === 0) return <div className="center-msg">Library is empty — download wallpapers from Browse.</div>;

  return (
    <>
    <div className="scroll lib-scroll" ref={scrollRef} onClick={onBgClick}>
      <div className="grid">
        {filtered.map((it) => (
          <LibraryCard key={it.videoPath} item={it}
            playing={it.videoPath === playingPath}
            selected={sel.has(it.videoPath)}
            focused={it.videoPath === libFocus}
            inPlaylist={playlist.includes(it.videoPath)}
            autoPlayGifs={autoPlayGifs}
            onClick={(e) => onCardClick(it, e)}
            onTrash={() => doTrash(targetsFor(it))}
            onToggle={() => doToggle(it)}
            onContextFocus={() => focusFromCard(it.videoPath)} />
        ))}
      </div>
    </div>
    {sideItem && (() => {
      const targets = targetsFor(sideItem);
      return (
        <SidePanel kind="library" id={sideItem.videoPath} closing={shown.closing} title={sideItem.title}
          sub={<SelectionNote n={targets.length} />} onClose={() => focusLib(null)}>
          <LibrarySide item={sideItem} targets={targets}
            playing={sideItem.videoPath === playingPath} keepCurrent={keepCurrent}
            inPlaylist={playlist.includes(sideItem.videoPath)}
            showDeleteFromSource={!!sideItem.workshopId && !autoImport}
            globalVolume={gVol} globalSpeed={gSpd}
            onPlay={() => applyItem(sideItem.videoPath)}
            onToggle={() => doToggle(sideItem)}
            onReveal={() => openExternal({ path: sideItem.videoPath, reveal: true, isScene: sideItem.isScene, workshopId: sideItem.workshopId, copiedSceneDir: sideItem.copiedSceneDir })}
            onTrash={() => { focusLib(null); doTrash(targets); }}
            onDeleteSource={() => { focusLib(null); deleteFromSource(targets.filter((i) => i.workshopId)); }} />
        </SidePanel>
      );
    })()}
    </>
  );
});
