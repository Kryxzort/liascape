import { memo, useRef, useState } from "react";
import { Trash2, AlertTriangle } from "lucide-react";
import { type LibraryItem } from "../api/client";
import { PlaylistToggle } from "./PlaylistToggle";
import { MotionThumb, hasGifAsset, hasVideoPreview } from "./MotionThumb";
import { useAutoplayVideo } from "./autoplay";

// USER-RULED FORK: compact library card — the card *is* the thumbnail with a 2-line centered
// title overlay (#66000000 bar), SCENE badge TL, ring/check playlist-toggle TR, trash BR (hover).
// PERF: memo'd; content-visibility (CSS) + per-card props; lift+glow hover (design choice).
// Its settings and actions live in the item sidebar (a click or a right-click focuses the card) — components/LibrarySide.tsx.
// COOL: animated preview on hover (MotionThumb); gif/webp assets also auto-play when AutoPlayGifs on.
export const LibraryCard = memo(function LibraryCard({
  item, playing, selected, focused, inPlaylist, autoPlayGifs, onClick, onTrash, onToggle, onContextFocus,
}: {
  item: LibraryItem; playing: boolean; selected: boolean; focused: boolean; inPlaylist: boolean; autoPlayGifs: boolean;
  onClick: (e: React.MouseEvent) => void; onTrash: () => void; onToggle: () => void; onContextFocus: () => void;
}) {
  const [hover, setHover] = useState(false);
  const active = hover || (autoPlayGifs && hasGifAsset(item));
  // "Autoplay video thumbnails": a video-only item on screen plays its video without a hover (a slot, components/autoplay.ts)
  const wrapRef = useRef<HTMLDivElement>(null);
  const autoVideo = useAutoplayVideo(wrapRef, hasVideoPreview(item));
  const cls = `card lib${playing ? " playing" : ""}${selected ? " selected" : ""}${focused ? " focused" : ""}${item.hasCrashed ? " crashed" : ""}`;
  return (
    <div className={cls}>
      {/* right-click = the item sidebar on this card WITHOUT applying it (docs/decisions.md § "Open the item sidebar on
          right-click; no context menus"); the sidebar has Open in file manager / Delete / Delete from
          source. Library.tsx keeps the card where it was while the docked sidebar re-fits the grid (gridKeys.ts keepCardInView). */}
      <div ref={wrapRef} className="thumb-wrap" data-morph-id={`lib-${item.videoPath}`} onClick={onClick}
        onContextMenu={(e) => { e.preventDefault(); onContextFocus(); }}
        onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
       >
        <MotionThumb item={item} active={active} autoVideo={autoVideo} />
        {item.isScene && <span className="badge">SCENE</span>}
        {item.hasCrashed && <span className="warn" title="Scene crashed — won't be played"><AlertTriangle size={15} /></span>}
        <button className={`pl-toggle${inPlaylist ? " on" : ""}`} title={inPlaylist ? "In playlist — click to remove" : "Add to playlist"}
          onClick={(e) => { e.stopPropagation(); onToggle(); }}><PlaylistToggle on={inPlaylist} /></button>
        <button className="del" aria-label="Delete" onClick={(e) => { e.stopPropagation(); onTrash(); }}><Trash2 size={24} /></button>
        {/* bottom title bar, 2-line clamp, centered white over #66000000 */}
        <div className="lib-title" data-title={item.title}><span>{item.title}</span></div>
      </div>
    </div>
  );
});
