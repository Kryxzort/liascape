import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import { LibraryCard } from "../components/LibraryCard";
import { useSmoothScroll } from "../hooks/useSmoothScroll";
import { useGridFit } from "../hooks/useGridFit";
import type { LibraryItem } from "../api/client";

const typing = () => {
  const el = document.activeElement as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
};

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
  const openItemSettings = useStore((s) => s.openItemSettings);
  const setStatus = useStore((s) => s.setStatus);
  const refreshPlayingStatus = useStore((s) => s.refreshPlayingStatus);
  const autoImport = useStore((s) => !!(s.settings?.autoImportWallpaperEngine));
  // gate autoplay on window focus/visibility (see App.tsx appActive) → backgrounded = gifs unmount, no decode drain
  const autoPlayGifs = useStore((s) => !!(s.settings?.autoPlayGifs) && s.appActive);

  const [sel, setSel] = useState<Set<string>>(new Set());
  const anchor = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  useSmoothScroll(scrollRef);
  useGridFit(scrollRef);

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

  // Ctrl+A select-all (filtered), Delete deletes selection, Escape clears — never while typing.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "a" && !typing()) { e.preventDefault(); setSel(new Set(filtered.map((i) => i.videoPath))); }
      else if (e.key === "Delete" && sel.size && !typing()) doTrash([...sel].map((p) => byPath[p]).filter(Boolean));
      else if (e.key === "Escape" && sel.size) setSel(new Set());
    };
    addEventListener("keydown", h);
    return () => removeEventListener("keydown", h);
  }); // eslint-disable-line

  const onCardClick = (it: LibraryItem, e: React.MouseEvent) => {
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

  if (items.length === 0) return <div className="center-msg">Library is empty — download wallpapers from Browse.</div>;

  return (
    <div className="scroll lib-scroll" ref={scrollRef} onClick={onBgClick}>
      <div className="grid">
        {filtered.map((it) => (
          <LibraryCard key={it.videoPath} item={it}
            playing={it.videoPath === playingPath}
            selected={sel.has(it.videoPath)}
            inPlaylist={playlist.includes(it.videoPath)}
            showDeleteFromSource={!!it.workshopId && !autoImport}
            autoPlayGifs={autoPlayGifs}
            onClick={(e) => onCardClick(it, e)}
            onTrash={() => doTrash(targetsFor(it))}
            onToggle={() => doToggle(it)}
            onDeleteSource={() => deleteFromSource(targetsFor(it).filter((i) => i.workshopId))}
            onReveal={() => openExternal({ path: it.videoPath, reveal: true, isScene: it.isScene, workshopId: it.workshopId, copiedSceneDir: it.copiedSceneDir })}
            onSettings={() => openItemSettings(it, targetsFor(it), `lib-${it.videoPath}`)} />
        ))}
      </div>
    </div>
  );
});
