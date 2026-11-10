import { memo, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Trash2, AlertTriangle } from "lucide-react";
import { type LibraryItem } from "../api/client";
import { PlaylistToggle } from "./PlaylistToggle";
import { MotionThumb, hasGifAsset, hasVideoPreview, pointerOver } from "./MotionThumb";
import { useAutoplayVideo } from "./autoplay";

// USER-RULED FORK: compact library card — the card *is* the thumbnail with a 2-line centered
// title overlay (#66000000 bar), SCENE badge TL, ring/check playlist-toggle TR, trash BR (hover).
// PERF: memo'd; content-visibility (CSS) + per-card props; lift+glow hover (design choice).
// The settings that were its right-click modal live in the item sidebar (focus the card) — components/LibrarySide.tsx.
// COOL: animated preview on hover (MotionThumb); gif/webp assets also auto-play when AutoPlayGifs on.
export const LibraryCard = memo(function LibraryCard({
  item, playing, selected, focused, inPlaylist, showDeleteFromSource, autoPlayGifs,
  onClick, onTrash, onToggle, onDeleteSource, onReveal, onSettings, onContextFocus,
}: {
  item: LibraryItem; playing: boolean; selected: boolean; focused: boolean; inPlaylist: boolean; showDeleteFromSource: boolean;
  autoPlayGifs: boolean;
  onClick: (e: React.MouseEvent) => void; onTrash: () => void; onToggle: () => void;
  onDeleteSource: () => void; onReveal: () => void; onSettings: () => void; onContextFocus: () => void;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number; thumb: HTMLElement } | null>(null);
  const [hover, setHover] = useState(false);
  // Closing says where the pointer is now: on the card the preview goes on without a restart, off it, it stops.
  const closeMenu = (e: React.MouseEvent) => { if (menu) setHover(pointerOver(menu.thumb, e)); setMenu(null); };
  // Escape closes the menu (and only the menu: the grid leaves its keys to an open .ctx-menu — hooks/gridKeys.ts)
  useEffect(() => {
    if (!menu) return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") setMenu(null); };
    addEventListener("keydown", h);
    return () => removeEventListener("keydown", h);
  }, [menu]);
  // an open menu holds the preview: right-clicking a card doesn't stop what its hover started
  const active = hover || !!menu || (autoPlayGifs && hasGifAsset(item));
  // "Autoplay video thumbnails": a video-only item on screen plays its video without a hover (a slot, components/autoplay.ts)
  const wrapRef = useRef<HTMLDivElement>(null);
  const autoVideo = useAutoplayVideo(wrapRef, hasVideoPreview(item));
  const cls = `card lib${playing ? " playing" : ""}${selected ? " selected" : ""}${focused ? " focused" : ""}${item.hasCrashed ? " crashed" : ""}`;
  return (
    <div className={cls}>
      {/* right-click = the menu at the cursor ("Settings" opens the item sidebar on it — no apply); while the sidebar is
          already open it also moves to this card (WE selects on a right-click). It doesn't OPEN the sidebar by itself: a docked
          sidebar re-fits the grid, which would slide the card out from under the menu and the pointer. */}
      <div ref={wrapRef} className="thumb-wrap" data-morph-id={`lib-${item.videoPath}`} onClick={onClick}
        onContextMenu={(e) => { e.preventDefault(); onContextFocus(); setMenu({ x: e.clientX, y: e.clientY, thumb: e.currentTarget }); }}
        onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
        title="Click: apply + details · Ctrl/Shift: select · Right-click: menu">
        <MotionThumb item={item} active={active} autoVideo={autoVideo} />
        {item.isScene && <span className="badge">SCENE</span>}
        {item.hasCrashed && <span className="warn" title="Scene crashed — won't be played"><AlertTriangle size={15} /></span>}
        <button className={`pl-toggle${inPlaylist ? " on" : ""}`} title={inPlaylist ? "In playlist — click to remove" : "Add to playlist"}
          onClick={(e) => { e.stopPropagation(); onToggle(); }}><PlaylistToggle on={inPlaylist} /></button>
        <button className="del" title="Delete" onClick={(e) => { e.stopPropagation(); onTrash(); }}><Trash2 size={24} /></button>
        {/* bottom title bar, 2-line clamp, centered white over #66000000 */}
        <div className="lib-title" title={item.title}><span>{item.title}</span></div>
      </div>

      {menu && createPortal(
        <>
          <div className="ctx-backdrop" onClick={closeMenu} onContextMenu={(e) => { e.preventDefault(); closeMenu(e); }} />
          {/* portal'd to body (the card's paint containment would otherwise trap position:fixed) */}
          <div className="ctx-menu lib-ctx" style={{ left: menu.x, top: menu.y }} onClick={closeMenu}>
            <button onClick={onSettings}>Settings</button>
            <button onClick={onReveal}>Open in file manager</button>
            <button onClick={onTrash}>Delete</button>
            {showDeleteFromSource && <button className="danger-item" onClick={onDeleteSource}>Delete from source (unsubscribe)</button>}
          </div>
        </>, document.body)}
    </div>
  );
});
