import { memo, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Trash2, AlertTriangle } from "lucide-react";
import { type LibraryItem } from "../api/client";
import { useStore } from "../store";
import { PlaylistToggle } from "./PlaylistToggle";
import { MotionThumb, hasGifAsset } from "./MotionThumb";

// USER-RULED FORK: compact library card — the card *is* the thumbnail with a 2-line centered
// title overlay (#66000000 bar), SCENE badge TL, ring/check playlist-toggle TR, trash BR (hover).
// PERF: memo'd; content-visibility (CSS) + per-card props; lift+glow hover (design choice).
// COOL: animated preview on hover (MotionThumb); gif/webp assets also auto-play when AutoPlayGifs on.
export const LibraryCard = memo(function LibraryCard({
  item, playing, selected, inPlaylist, showDeleteFromSource, autoPlayGifs,
  onClick, onTrash, onToggle, onDeleteSource, onReveal, onSettings,
}: {
  item: LibraryItem; playing: boolean; selected: boolean; inPlaylist: boolean; showDeleteFromSource: boolean;
  autoPlayGifs: boolean;
  onClick: (e: React.MouseEvent) => void; onTrash: () => void; onToggle: () => void;
  onDeleteSource: () => void; onReveal: () => void; onSettings: () => void;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [hover, setHover] = useState(false);
  // hide this card's animated overlay while ITS settings modal is open AND through the close-morph
  // afterwards (else the gif snaps back into the card while the modal is still morphing closed).
  const settingsOpen = useStore((s) => s.settingsItem?.videoPath === item.videoPath);
  const [cooldown, setCooldown] = useState(false);
  useEffect(() => {
    if (settingsOpen) { setCooldown(true); return; }
    const t = setTimeout(() => setCooldown(false), 360); // ~close-morph duration
    return () => clearTimeout(t);
  }, [settingsOpen]);
  const active = !settingsOpen && !cooldown && (hover || (autoPlayGifs && hasGifAsset(item)));
  // un-clip + raise this card while its modal opens/closes so the reverse morph isn't clipped to the frame
  const morphing = settingsOpen || cooldown;
  const cls = `card lib${playing ? " playing" : ""}${selected ? " selected" : ""}${item.hasCrashed ? " crashed" : ""}${morphing ? " morphing" : ""}`;
  return (
    <div className={cls}>
      <div className="thumb-wrap" onClick={onClick} onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); }}
        onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
        title="Click: apply · Ctrl/Shift: select · Right-click: menu">
        <MotionThumb item={item} active={active} morphId={morphing ? `lib-${item.videoPath}` : undefined} />
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
          <div className="ctx-backdrop" onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
          {/* portal'd to body (the card's paint containment would otherwise trap position:fixed) */}
          <div className="ctx-menu lib-ctx" style={{ left: menu.x, top: menu.y }} onClick={() => setMenu(null)}>
            <button onClick={onSettings}>Settings (volume / speed)</button>
            <button onClick={onReveal}>Open in file manager</button>
            <button onClick={onTrash}>Delete</button>
            {showDeleteFromSource && <button className="danger-item" onClick={onDeleteSource}>Delete from source (unsubscribe)</button>}
          </div>
        </>, document.body)}
    </div>
  );
});
