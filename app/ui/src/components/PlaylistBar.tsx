import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  DndContext, DragOverlay, closestCenter, PointerSensor, useSensor, useSensors,
  type DragEndEvent, type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ChevronRight, ChevronDown, SlidersHorizontal, Save, FolderOpen, Play, X, LocateFixed,
} from "lucide-react";
import { useStore } from "../store";
import { type LibraryItem } from "../api/client";
import { SavePlaylistModal } from "./SavePlaylistModal";
import { LoadPlaylistModal } from "./LoadPlaylistModal";
import { PlaylistSettingsModal } from "./PlaylistSettingsModal";
import { MotionThumb } from "./MotionThumb";
import { hasGifAsset, hasVideoPreview } from "./mediaAssets";
import { useAutoplayVideo } from "./autoplay";
import { useTravelToPlaying, glideTo } from "../hooks/travelToPlaying";
import { useSmoothScroll } from "../hooks/useSmoothScroll";
import { useDockLift, dockOwnsFrame } from "../hooks/useDockLift";
import { useMotion } from "./motion";
import { revealCard } from "../hooks/gridKeys";

// The hovered item is the ROW's state (the hover must survive the gaps between playlist items):
// entering an item hovers it, the 10 px gaps between items keep the last one, and leaving the row (or the empty space past
// its ends) clears it. A CSS :hover drops in every gap, so the dock lift would sink and re-rise crossing from item to item.
// PERF: it lives outside PlaylistBar's React state — a hover change re-renders only the item it leaves and the one it
// enters, not the bar (its DndContext, modals and every item's props). Each item holds its own `hover` state, set from
// the same event handlers as before (same render timing). Guard: probe-plbar bar:sweepCost.
type Hover = { get: () => string | null; set: (p: string | null) => void; item: (path: string, on: (v: boolean) => void) => () => void };
function hoverStore(): Hover {
  let cur: string | null = null;
  const items = new Map<string, (v: boolean) => void>();
  return {
    get: () => cur,
    set(p) {
      if (p === cur) return;
      if (cur !== null) items.get(cur)?.(false);
      cur = p;
      if (p !== null) items.get(p)?.(true);
    },
    item(path, on) {
      items.set(path, on); on(cur === path);
      return () => { if (items.get(path) === on) items.delete(path); };
    },
  };
}
const PlItem = memo(function PlItem({ path, item, index, playing, hv }:
  { path: string; item?: LibraryItem; index: number; playing: boolean; hv: Hover }) {
  const [hover, setHoverOn] = useState(() => hv.get() === path);
  useEffect(() => hv.item(path, setHoverOn), [hv, path]);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: path });
  const removeFromPlaylist = useStore((s) => s.removeFromPlaylist);
  const playFrom = useStore((s) => s.playFrom);
  const focusLib = useStore((s) => s.focusLib);
  // gate autoplay on window focus/visibility (see App.tsx appActive) → backgrounded = gifs unmount, no decode drain
  const autoPlayGifs = useStore((s) => !!(s.settings?.autoPlayGifs) && s.appActive);
  const glows = useStore((s) => s.settings?.glows !== false); // Settings → "Glow effects": off = no hover-glow layer
  // COOL: the hover glow can't escape the x-scrolling row (overflow clips it vertically). Render it as
  // a position:fixed layer portal'd to <body> at the item's box → it floats OVER the playlist bar chrome with
  // zero row padding. While hovered a rAF loop writes the item's box straight into the glow's style — a transform, so it
  // sits at the same sub-pixel position as the lifting item (left/top would snap to whole pixels and shimmer against it),
  // and no React render per frame. The first write happens before paint (layout effect): no frame at 0,0.
  // While the dock animates, the box is read only in its "dockframe" signal (after its writes; hooks/useDockLift.ts
  // dockOwnsFrame): the loop's own read would land before or after them and force a recalc / layout per frame.
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
    // the dock magnification moves the item in ITS rAF callback — which may run after this one in a frame: it signals each
    // frame it wrote, so the glow re-reads the box in that same frame (never a frame behind the growing item)
    const row = boxRef.current?.parentElement;
    const tick = (t: number) => { if (!dockOwnsFrame(row, t)) write(); raf = requestAnimationFrame(tick); };
    write();
    raf = requestAnimationFrame(tick);
    row?.addEventListener("dockframe", write);
    return () => { cancelAnimationFrame(raf); row?.removeEventListener("dockframe", write); };
  }, [hover]);
  const onEnter = () => hv.set(path);
  const active = !!item && (hover || (autoPlayGifs && hasGifAsset(item)));
  // "Autoplay video thumbnails": a video-only item in view plays its video without a hover (a slot, components/autoplay.ts)
  const autoVideo = useAutoplayVideo(boxRef, !!item && !isDragging && hasVideoPreview(item));
  // while dragging, the visible copy is the DragOverlay (portal'd above all UI); hide the in-place
  // source but keep it mounted so the sortable still reserves its gap.
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0 : 1 };
  return (
    <div ref={(n) => { boxRef.current = n; setNodeRef(n); }} style={style} className={`pl-item${playing ? " playing" : ""}${hover ? " hov" : ""}`} data-morph-id={`pl-${path}`} data-title={item?.title}
      {...attributes} {...listeners} onClick={() => playFrom(index)}
      onMouseEnter={onEnter}
      // right-click = the item's Library sidebar, the grid's card scrolled into view; nothing plays (docs/decisions.md §
      // "Open the item sidebar on right-click; no context menus" — the sidebar has the playlist toggle, Open in file manager, Delete)
      onContextMenu={(e) => { e.preventDefault(); focusLib(path); revealCard(`lib-${path}`); }}>
      {item && <MotionThumb item={item} active={active} autoVideo={autoVideo} />}
      {/* #99000000 title bar, 10px white ellipsis */}
      <div className="pl-title">{item?.title ?? ""}</div>
      <button className="pl-remove" aria-label="Remove from playlist"
        onClick={(e) => { e.stopPropagation(); removeFromPlaylist(path); }}><X size={21} /></button>
      {hover && glows && !playing && !isDragging && createPortal(<div className="pl-hover-glow" ref={glowRef} />, document.body)}
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

// --playlist-bar-h on :root: the library scroll's bottom margin (index.css .lib-scroll)
let barH = -1;
function setBarH(h: number) {
  if (h === barH) return;
  barH = h;
  document.documentElement.style.setProperty("--playlist-bar-h", `${h}px`);
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
  // wheel listener whenever it (re)mounts — attached once at mount, the bar never scrolls
  const rowShown = !collapsed && playlist.length > 0;
  useSmoothScroll(rowRef, "x", [rowShown]);
  const [hv] = useState(hoverStore);
  const motion = useMotion();
  // the dock magnification follows the pointer's x (hooks/useDockLift.ts); the hovered item (above) only drives the glow,
  // the remove button, the preview — and the lift's fallback with motion off
  useDockLift(rowRef, motion, !!dragId, [rowShown, playlist.length]);
  // the pointer on the row itself (not on an item): inside the run of items = a gap (keep), past either end = off them
  // …and above the items' strip (the row reaches up into the head for the magnified items' headroom) = off them too
  const onRowMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const row = e.currentTarget;
    if (e.target !== row || !hv.get()) return;
    const first = row.firstElementChild?.getBoundingClientRect(), last = row.lastElementChild?.getBoundingClientRect();
    const top = row.getBoundingClientRect().top + (parseFloat(getComputedStyle(row).paddingTop) || 0);
    if (!first || !last || e.clientX < first.left || e.clientX > last.right || e.clientY < top) hv.set(null);
  };
  // …and the playlist bar's playing item (horizontal; once per session)
  useTravelToPlaying(rowRef, "playlistBar", "x", ".pl-item.playing", playingPath, playlist.length);
  // expose the playlist bar's live height as --playlist-bar-h so the library scroll can pad its bottom enough to
  // reveal the last row above the bar — whether it's collapsed or expanded.
  // PERF: from the observer's own size (its first callback lands after the frame's layout, before its paint), written only
  // when it changed and kept while the bar is away (only the library page, shown with the bar, reads it): reading
  // offsetHeight at mount forced a layout inside the tab switch, and each write on :root restyles the whole page.
  // Guard: probe-layout perf:tabs.
  const playlistBarRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = playlistBarRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setBarH(Math.round(e.borderBoxSize[0].blockSize)));
    ro.observe(el);
    return () => ro.disconnect();
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
        <button className="mini" aria-label={collapsed ? "Expand" : "Collapse"}
          onClick={() => { hv.set(null); setSetting("isPlaylistBarCollapsed", !collapsed); }}>{collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}</button>
        <span className="playlist-bar-label">PLAYLIST</span>
        <span className="playlist-bar-count">{playlist.length}</span>
        <button className="mini ico" title="Playlist settings" onClick={() => setShowSettings(true)}><SlidersHorizontal size={15} /></button>
        <button className="mini ico" title="Save playlist" onClick={() => setShowSave(true)}><Save size={15} /></button>
        <button className="mini ico" title="Load playlist" onClick={() => setShowLoad(true)}><FolderOpen size={15} /></button>
        {/* "Go to playing": glides the row to the playing item and rings it; only when it's in the playlist */}
        <button className="mini ico go-playing" data-go-playing="bar" disabled={collapsed || !playingPath || !playlist.includes(playingPath)}
          title={playingPath && playlist.includes(playingPath) ? "Show the playing wallpaper in the playlist" : "The playing wallpaper isn't in the playlist"}
          onClick={() => glideTo(rowRef.current, ".pl-item.playing", "x", motion)}><LocateFixed size={15} /></button>
        <div className="spacer" />
        <button className="play-btn ico" onClick={() => play()} disabled={playlist.length === 0}><Play size={15} /> Play</button>
      </div>

      {!collapsed && (playlist.length === 0 ? (
        <div className="playlist-bar-empty">Add wallpapers with the toggle on library cards</div>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter}
          onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={onDragCancel}>
          <SortableContext items={playlist} strategy={horizontalListSortingStrategy}>
            <div className="playlist-bar-row" ref={rowRef} onMouseMove={onRowMove} onMouseLeave={() => hv.set(null)}>
              {playlist.map((p, i) => <PlItem key={p} path={p} item={byPath[p]} index={i} playing={p === playingPath} hv={hv} />)}
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
