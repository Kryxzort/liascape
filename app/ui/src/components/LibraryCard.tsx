import { memo, useRef, useState } from "react";
import { Trash2, AlertTriangle, Unplug } from "lucide-react";
import { type LibraryItem } from "../api/client";
import { PlaylistToggle } from "./PlaylistToggle";
import { MotionThumb } from "./MotionThumb";
import { usePreviewKinds } from "./mediaAssets";
import { useAutoplayVideo } from "./autoplay";
import { useSeenCard } from "./previewQueue";
import { TypeBadge } from "./TypeBadge";

// USER-RULED FORK: compact library card — the card *is* the thumbnail with a 2-line centered
// title overlay (#66000000 bar), SCENE badge TL, ring/check playlist-toggle TR, trash BR (hover).
// PERF: memo'd; content-visibility (CSS) + per-card props; lift+glow hover (design choice).
// A click applies it; its settings and actions live in the item sidebar (a right-click focuses the card) — components/LibrarySide.tsx.
// COOL: animated preview (MotionThumb): what it shows hovered and not follows Settings → "On hover" / "Not hovered".
export const LibraryCard = memo(function LibraryCard({
  item, playing, selected, focused, inPlaylist, unsub, unsubOff, reason, onClick, onTrash, onToggle, onContextFocus,
}: {
  // unsub: its Delete is Unsubscribe (a subscribed Workshop item with auto-import on: Library.tsx doTrash); unsubOff: it can't
  // unsubscribe now (signed out): the button shows disabled, its name says why, and a click only puts that in the status bar
  // (no tooltips on cards). Guard: probe-steam side:unsub:signedOut
  item: LibraryItem; playing: boolean; selected: boolean; focused: boolean; inPlaylist: boolean; unsub?: boolean; unsubOff?: string | null;
  // why it can't play now (a preset: its base scene gone; a scene or preset: the scene renderer missing —
  // store unplayableReasonOf), else null: the card greys
  // out with a status icon whose tooltip is the reason, and a click plays nothing (store applyItem says why in the status bar)
  reason?: string | null;
  // PERF: each takes the item, so the list passes the same function to every card (Library.tsx useStableFn) and a
  // focus / selection change re-renders only the cards whose own props changed
  onClick: (item: LibraryItem, e: React.MouseEvent) => void; onTrash: (item: LibraryItem) => void; onToggle: (item: LibraryItem) => void;
  onContextFocus: (item: LibraryItem) => void;
}) {
  const [hover, setHover] = useState(false);
  const { hoverKind, idleKind } = usePreviewKinds(item);
  // unhovered showing its video: on screen it plays a clip of it (components/autoplay.ts)
  const wrapRef = useRef<HTMLDivElement>(null);
  const autoVideo = useAutoplayVideo(wrapRef, idleKind === "video");
  // on screen: its previews are made first if the backend still lacks them (components/previewQueue.ts)
  useSeenCard(wrapRef, item.videoPath);
  // COOL: a preset or scene greys out and its status icon fades in when it stops being playable, and back (CSS transitions on a state
  // class, never a mount animation: the page is hidden and shown again by <Activity>, which would replay one)
  const cls = `card lib${playing ? " playing" : ""}${selected ? " selected" : ""}${focused ? " focused" : ""}${item.hasCrashed && !reason ? " crashed" : ""}${reason ? " unplayable" : ""}`;
  return (
    <div className={cls} data-key={item.videoPath}>
      {/* right-click = the item sidebar on this card WITHOUT applying it, a click = apply only (docs/decisions.md § "Left click
          does the tab's main action, right click opens the item sidebar"); the sidebar has Open in file manager / Delete / Delete from
          source. Library.tsx keeps the card where it was while the docked sidebar re-fits the grid (gridKeys.ts keepCardInView). */}
      <div ref={wrapRef} className="thumb-wrap" data-morph-id={`lib-${item.videoPath}`} onClick={(e) => onClick(item, e)}
        onContextMenu={(e) => { e.preventDefault(); onContextFocus(item); }}
        onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
       >
        <MotionThumb item={item} hover={hover} hoverKind={hoverKind} idleKind={idleKind} autoVideo={autoVideo} />
        {/* a preset is a scene for everything else (greying, "Play scenes" off); only its badge names it. Guard: probe-sidebar
            lib:preset:badge */}
        {item.isScene && <TypeBadge preset={item.isPreset} />}
        {/* Guard: probe-sidebar lib:preset:needsBase, lib:scenesBlocked (a scene's too) */}
        {(item.isPreset || item.isScene) && <span className={`warn preset${reason ? " on" : ""}`} data-card-reason={reason ?? ""} title={reason ?? undefined}
          aria-hidden={reason ? undefined : true}><Unplug size={15} /></span>}
        {item.hasCrashed && !reason && <span className="warn" title="Scene crashed — rotations skip it"><AlertTriangle size={15} /></span>}
        <button className={`pl-toggle${inPlaylist ? " on" : ""}`} title={inPlaylist ? "In playlist — click to remove" : "Add to playlist"}
          onClick={(e) => { e.stopPropagation(); onToggle(item); }}><PlaylistToggle on={inPlaylist} /></button>
        <button className="del" aria-label={unsub ? (unsubOff ?? "Unsubscribe") : "Delete"} aria-disabled={unsubOff ? true : undefined}
          onClick={(e) => { e.stopPropagation(); onTrash(item); }}><Trash2 size={24} /></button>
        {/* bottom title bar, 2-line clamp, centered white over #66000000 */}
        <div className="lib-title" data-title={item.title}><span>{item.title}</span></div>
      </div>
    </div>
  );
});
