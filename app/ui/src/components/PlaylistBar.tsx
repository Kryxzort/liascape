import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { createPortal } from "react-dom";
import {
  DndContext, DragOverlay, closestCenter, PointerSensor, useSensor, useSensors,
  type DragEndEvent, type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ChevronRight, ChevronDown, SlidersHorizontal, Save, FolderOpen, Play, X,
} from "lucide-react";
import { useStore } from "../store";
import { type LibraryItem } from "../api/client";
import { SavePlaylistModal } from "./SavePlaylistModal";
import { LoadPlaylistModal } from "./LoadPlaylistModal";
import { PlaylistSettingsModal } from "./PlaylistSettingsModal";
import { MotionThumb, hasGifAsset, hasVideoPreview, pointerOver } from "./MotionThumb";
import { useAutoplayVideo } from "./autoplay";
import { useTravelToPlaying } from "../hooks/travelToPlaying";
import { useSmoothScroll } from "../hooks/useSmoothScroll";
import { useDockLift } from "../hooks/useDockLift";
import { useMotion } from "./motion";
import { revealCard } from "../hooks/gridKeys";

// The hovered item is the ROW's state (owner 2026-11-11: "doesn't lose the hover thing in the gaps between playlist items"):
// entering an item hovers it, the 10 px gaps between items keep the last one, and leaving the row (or the empty space past
// its ends) clears it. A CSS :hover dropped in every gap, so the dock lift sank and re-rose crossing from item to item.
type SetHover = Dispatch<SetStateAction<string | null>>;
const PlItem = memo(function PlItem({ path, item, index, playing, hover, setHover }:
  { path: string; item?: LibraryItem; index: number; playing: boolean; hover: boolean; setHover: SetHover }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: path });
  const removeFromPlaylist = useStore((s) => s.removeFromPlaylist);
  const playFrom = useStore((s) => s.playFrom);
  const openExternal = useStore((s) => s.openExternal);
  const focusLib = useStore((s) => s.focusLib);
  // gate autoplay on window focus/visibility (see App.tsx appActive) → backgrounded = gifs unmount, no decode drain
  const autoPlayGifs = useStore((s) => !!(s.settings?.autoPlayGifs) && s.appActive);
  const glows = useStore((s) => s.settings?.glows !== false); // Settings → "Glow effects": off = no hover-glow layer
  const [menu, setMenu] = useState<{ x: number; y: number; el: HTMLElement } | null>(null);
  // COOL: the hover glow can't escape the x-scrolling row (overflow clips it vertically). Render it as
  // a position:fixed layer portal'd to <body> at the item's box → it floats OVER the playlist bar chrome with
  // zero row padding. While hovered a rAF loop writes the item's box straight into the glow's style — a transform, so it
  // sits at the same sub-pixel position as the lifting item (left/top would snap to whole pixels and shimmer against it),
  // and no React render per frame. The first write happens before paint (layout effect): no frame at 0,0.
  const boxRef = useRef<HTMLDivElement | null>(null);
  const glowRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (!hover) return;
    let raf = 0, last = "", lastG: HTMLDivElement | null = null;
    const write = () => {
      const el = boxRef.current, g = glowRef.current;
      if (!el || !g) return;
      const r = el.getBoundingClientRect(), k = `${r.left},${r.top},${r.width},${r.height}`;
      if (k === last && g === lastG) return; // a glow mounted later (glows / drag toggled) gets its first write too
      last = k; lastG = g;
      g.style.transform = `translate3d(${r.left}px, ${r.top}px, 0)`;
      g.style.width = `${r.width}px`; g.style.height = `${r.height}px`;
    };
    const tick = () => { write(); raf = requestAnimationFrame(tick); };
    write();
    raf = requestAnimationFrame(tick);
    // the dock magnification moves the item in ITS rAF callback — which may run after this one in a frame: it signals each
    // frame it wrote, so the glow re-reads the box in that same frame (never a frame behind the growing item)
    const row = boxRef.current?.parentElement;
    row?.addEventListener("dockframe", write);
    return () => { cancelAnimationFrame(raf); row?.removeEventListener("dockframe", write); };
  }, [hover]);
  const onEnter = () => setHover(path);
  const onLeave = () => setHover((cur) => (cur === path ? null : cur));
  // The portal'd menu is this item's React child, so going from it to elsewhere fires no leave here: closing off the item is the leave.
  const closeMenu = (e: React.MouseEvent) => { if (menu && !pointerOver(menu.el, e)) onLeave(); setMenu(null); };
  useEffect(() => {
    if (!menu) return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") { setMenu(null); onLeave(); } };
    addEventListener("keydown", h);
    return () => removeEventListener("keydown", h);
  }, [menu]); // eslint-disable-line react-hooks/exhaustive-deps
  // an open menu holds the preview, as on a library card
  const active = !!item && (hover || !!menu || (autoPlayGifs && hasGifAsset(item)));
  // "Autoplay video thumbnails": a video-only item in view plays its video without a hover (a slot, components/autoplay.ts)
  const autoVideo = useAutoplayVideo(boxRef, !!item && !isDragging && hasVideoPreview(item));
  // while dragging, the visible copy is the DragOverlay (portal'd above all UI); hide the in-place
  // source but keep it mounted so the sortable still reserves its gap.
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0 : 1 };
  return (
    <div ref={(n) => { boxRef.current = n; setNodeRef(n); }} style={style} className={`pl-item${playing ? " playing" : ""}${hover ? " hov" : ""}`} data-morph-id={`pl-${path}`}
      {...attributes} {...listeners} onClick={() => playFrom(index)} title={item?.title}
      onMouseEnter={onEnter}
      onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, el: e.currentTarget }); }}>
      {item && <MotionThumb item={item} active={active} autoVideo={autoVideo} />}
      {/* #99000000 title bar, 10px white ellipsis */}
      <div className="pl-title">{item?.title ?? ""}</div>
      <button className="pl-remove" title="Remove from playlist"
        onClick={(e) => { e.stopPropagation(); removeFromPlaylist(path); }}><X size={21} /></button>
      {hover && glows && !playing && !isDragging && createPortal(<div className="pl-hover-glow" ref={glowRef} />, document.body)}
      {menu && item && createPortal(
        // React bubbles a portal's events through the React tree, i.e. into this .pl-item's
        // onClick (playFrom) / sortable listeners — a menu click must stop here.
        <div style={{ display: "contents" }} onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}>
          <div className="ctx-backdrop" onClick={closeMenu} onContextMenu={(e) => { e.preventDefault(); closeMenu(e); }} />
          {/* portal'd: the playlist bar's backdrop-filter would otherwise trap position:fixed */}
          <div className="ctx-menu pl-ctx" style={{ left: menu.x, top: menu.y }} onClick={closeMenu}>
            <button onClick={() => removeFromPlaylist(path)}>Remove from playlist</button>
            {/* the item's settings live in the Library sidebar: focus it there (the grid scrolls its card into view) */}
            <button onClick={() => { focusLib(path); revealCard(`lib-${path}`); }}>Settings</button>
            <button onClick={() => openExternal({ path: item.videoPath, reveal: true, isScene: item.isScene, workshopId: item.workshopId, copiedSceneDir: item.copiedSceneDir })}>Open in file manager</button>
          </div>
        </div>, document.body)}
    </div>
  );
});

// The thing shown floating under the cursor while dragging — rendered in a DragOverlay portal'd to
// <body>, so it sits ABOVE all UI (not clipped by the playlist bar's overflow / backdrop-filter containing block).
function PlItemOverlay({ item }: { item?: LibraryItem }) {
  return (
    <div className="pl-item dragging" style={{ cursor: "grabbing", boxShadow: "0 12px 28px rgba(0,0,0,.5)", transform: "scale(1.05)" }}>
      {item && <MotionThumb item={item} active={false} />}
      <div className="pl-title">{item?.title ?? ""}</div>
    </div>
  );
}

export function PlaylistBar() {
  const playlist = useStore((s) => s.playlist);
  const items = useStore((s) => s.libraryItems);
  const playingPath = useStore((s) => s.playingPath);
  const reorder = useStore((s) => s.reorderPlaylist);
  const play = useStore((s) => s.playPlaylist);
  const ps = useStore((s) => s.playlistSettings);
  const setPS = useStore((s) => s.setPlaylistSettings);
  const names = useStore((s) => s.playlistNames);
  const saveAs = useStore((s) => s.savePlaylistAs);
  const loadNamed = useStore((s) => s.loadNamedPlaylist);
  const collapsed = useStore((s) => !!(s.settings?.isPlaylistBarCollapsed));
  const autoAdd = useStore((s) => !!(s.settings?.autoAddLibraryToPlaylist));
  const setSetting = useStore((s) => s.setSetting);

  const [showSettings, setShowSettings] = useState(false);
  const [showSave, setShowSave] = useState(false);
  const [showLoad, setShowLoad] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null); // the item currently picked up (→ DragOverlay)
  const byPath = useMemo(() => Object.fromEntries(items.map((i) => [i.videoPath, i])), [items]);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const rowRef = useRef<HTMLDivElement>(null);
  // the row only exists while the bar is expanded and the playlist has items (it loads after the first render): re-attach the
  // wheel listener whenever it (re)mounts — attached once at mount, the bar never scrolled (owner 2026-11-11: "i cant scroll on
  // playlist bar")
  const rowShown = !collapsed && playlist.length > 0;
  useSmoothScroll(rowRef, "x", [rowShown]);
  const [hoverPath, setHoverPath] = useState<string | null>(null);
  const motion = useMotion();
  // the dock magnification follows the pointer's x (hooks/useDockLift.ts); the hovered item (above) only drives the glow,
  // the remove button, the preview — and the lift's fallback with motion off
  useDockLift(rowRef, motion, !!dragId, [rowShown, playlist.length]);
  // the pointer on the row itself (not on an item): inside the run of items = a gap (keep), past either end = off them
  // …and above the items' strip (the row reaches up into the head for the magnified items' headroom) = off them too
  const onRowMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const row = e.currentTarget;
    if (e.target !== row || !hoverPath) return;
    const first = row.firstElementChild?.getBoundingClientRect(), last = row.lastElementChild?.getBoundingClientRect();
    const top = row.getBoundingClientRect().top + (parseFloat(getComputedStyle(row).paddingTop) || 0);
    if (!first || !last || e.clientX < first.left || e.clientX > last.right || e.clientY < top) setHoverPath(null);
  };
  // …and the playlist bar's playing item (horizontal; once per session)
  useTravelToPlaying(rowRef, "playlistBar", "x", ".pl-item.playing", playingPath, playlist.length);
  // expose the playlist bar's live height as --playlist-bar-h so the library scroll can pad its bottom enough to
  // reveal the last row above the bar — whether it's collapsed or expanded.
  const playlistBarRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = playlistBarRef.current;
    if (!el) return;
    const apply = () => document.documentElement.style.setProperty("--playlist-bar-h", `${Math.round(el.offsetHeight)}px`);
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => { ro.disconnect(); document.documentElement.style.removeProperty("--playlist-bar-h"); };
  }, []);

  const onDragStart = (e: DragStartEvent) => setDragId(String(e.active.id));
  const onDragEnd = (e: DragEndEvent) => {
    setDragId(null);
    // FIX: after a pointer drop dnd-kit leaves focus on the (now-reordered) item → a stray :focus-visible
    // outline lands on the wrong card until the mouse moves. Blur it so the outline clears immediately.
    (document.activeElement as HTMLElement | null)?.blur?.();
    const { active, over } = e;
    if (over && active.id !== over.id) {
      const from = playlist.indexOf(String(active.id)), to = playlist.indexOf(String(over.id));
      if (from >= 0 && to >= 0) reorder(from, to);
    }
  };
  const onDragCancel = () => { setDragId(null); (document.activeElement as HTMLElement | null)?.blur?.(); };

  return (
    <div className="playlist-bar" ref={playlistBarRef}>
      <div className="playlist-bar-head">
        <button className="mini" title={collapsed ? "Expand" : "Collapse"}
          onClick={() => { setHoverPath(null); setSetting("isPlaylistBarCollapsed", !collapsed); }}>{collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}</button>
        <span className="playlist-bar-label">PLAYLIST</span>
        <span className="playlist-bar-count">{playlist.length}</span>
        <button className="mini ico" title="Playlist settings" onClick={() => setShowSettings(true)}><SlidersHorizontal size={15} /></button>
        <button className="mini ico" title="Save playlist" onClick={() => setShowSave(true)}><Save size={15} /></button>
        <button className="mini ico" title="Load playlist" onClick={() => setShowLoad(true)}><FolderOpen size={15} /></button>
        <div className="spacer" />
        <button className="play-btn ico" onClick={() => play()} disabled={playlist.length === 0}><Play size={15} /> Play</button>
      </div>

      {!collapsed && (playlist.length === 0 ? (
        <div className="playlist-bar-empty">Add wallpapers with the toggle on library cards</div>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter}
          onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={onDragCancel}>
          <SortableContext items={playlist} strategy={horizontalListSortingStrategy}>
            <div className="playlist-bar-row" ref={rowRef} onMouseMove={onRowMove} onMouseLeave={() => setHoverPath(null)}>
              {playlist.map((p, i) => <PlItem key={p} path={p} item={byPath[p]} index={i} playing={p === playingPath}
                hover={hoverPath === p} setHover={setHoverPath} />)}
            </div>
          </SortableContext>
          {/* DragOverlay portal'd to <body> → the picked-up item floats ABOVE all UI (the playlist bar's
              overflow + backdrop-filter would otherwise clip an in-place transform) */}
          {createPortal(<DragOverlay>{dragId ? <PlItemOverlay item={byPath[dragId]} /> : null}</DragOverlay>, document.body)}
        </DndContext>
      ))}

      {/* portal'd to body so the playlist bar's backdrop-filter containing block doesn't pin them off-screen */}
      {createPortal(<>
        <PlaylistSettingsModal open={showSettings} ps={ps} setPS={setPS}
          autoAdd={autoAdd} setAutoAdd={(v) => setSetting("autoAddLibraryToPlaylist", v)} onClose={() => setShowSettings(false)} />
        <SavePlaylistModal open={showSave} names={names} onSave={saveAs} onClose={() => setShowSave(false)} />
        <LoadPlaylistModal open={showLoad} names={names} onLoad={loadNamed} onClose={() => setShowLoad(false)} />
      </>, document.body)}
    </div>
  );
}
