import { memo, useRef, useState } from "react";
import { Trash2, AlertTriangle } from "lucide-react";
import { type LibraryItem } from "../api/client";
import { PlaylistToggle } from "./PlaylistToggle";
import { MotionThumb } from "./MotionThumb";
import { hasGifAsset, hasVideoPreview, useVideoOverGif } from "./mediaAssets";
import { useAutoplayVideo } from "./autoplay";

// USER-RULED FORK: compact library card — the card *is* the thumbnail with a 2-line centered
// title overlay (#66000000 bar), SCENE badge TL, ring/check playlist-toggle TR, trash BR (hover).
// PERF: memo'd; content-visibility (CSS) + per-card props; lift+glow hover (design choice).
// A click applies it; its settings and actions live in the item sidebar (a right-click focuses the card) — components/LibrarySide.tsx.
// COOL: animated preview on hover (MotionThumb); gif/webp assets also auto-play when AutoPlayGifs on, video previews under
// "Animate wallpapers without a GIF".
export const LibraryCard = memo(function LibraryCard({
  item, playing, selected, focused, inPlaylist, unsub, autoPlayGifs, onClick, onTrash, onToggle, onContextFocus,
}: {
  // unsub: its Delete is Unsubscribe (a subscribed Workshop item with auto-import on: Library.tsx doTrash)
  item: LibraryItem; playing: boolean; selected: boolean; focused: boolean; inPlaylist: boolean; unsub?: boolean; autoPlayGifs: boolean;
  // PERF: each takes the item, so the list passes the same function to every card (Library.tsx useStableFn) and a
  // focus / selection change re-renders only the cards whose own props changed
  onClick: (item: LibraryItem, e: React.MouseEvent) => void; onTrash: (item: LibraryItem) => void; onToggle: (item: LibraryItem) => void;
  onContextFocus: (item: LibraryItem) => void;
}) {
  const [hover, setHover] = useState(false);
  const autoGif = autoPlayGifs && hasGifAsset(item);
  const videoOverGif = useVideoOverGif();
  // "Animate wallpapers without a GIF": an item on screen with no GIF plays a clip of its own video without a hover (components/autoplay.ts)
  const wrapRef = useRef<HTMLDivElement>(null);
  const autoVideo = useAutoplayVideo(wrapRef, hasVideoPreview(item, videoOverGif));
  const cls = `card lib${playing ? " playing" : ""}${selected ? " selected" : ""}${focused ? " focused" : ""}${item.hasCrashed ? " crashed" : ""}`;
  return (
    <div className={cls}>
      {/* right-click = the item sidebar on this card WITHOUT applying it, a click = apply only (docs/decisions.md § "Left click
          does the tab's main action, right click opens the item sidebar"); the sidebar has Open in file manager / Delete / Delete from
          source. Library.tsx keeps the card where it was while the docked sidebar re-fits the grid (gridKeys.ts keepCardInView). */}
      <div ref={wrapRef} className="thumb-wrap" data-morph-id={`lib-${item.videoPath}`} onClick={(e) => onClick(item, e)}
        onContextMenu={(e) => { e.preventDefault(); onContextFocus(item); }}
        onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
       >
        <MotionThumb item={item} hover={hover} autoGif={autoGif} autoVideo={autoVideo} videoOverGif={videoOverGif} />
        {item.isScene && <span className="badge">SCENE</span>}
        {item.hasCrashed && <span className="warn" title="Scene crashed — rotations skip it"><AlertTriangle size={15} /></span>}
        <button className={`pl-toggle${inPlaylist ? " on" : ""}`} title={inPlaylist ? "In playlist — click to remove" : "Add to playlist"}
          onClick={(e) => { e.stopPropagation(); onToggle(item); }}><PlaylistToggle on={inPlaylist} /></button>
        <button className="del" aria-label={unsub ? "Unsubscribe" : "Delete"} onClick={(e) => { e.stopPropagation(); onTrash(item); }}><Trash2 size={24} /></button>
        {/* bottom title bar, 2-line clamp, centered white over #66000000 */}
        <div className="lib-title" data-title={item.title}><span>{item.title}</span></div>
      </div>
    </div>
  );
});
