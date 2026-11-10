import { memo, useEffect, useState } from "react";
import { Check, X } from "lucide-react";
import { thumb, anim, still, CARD_STILL_W, type Wallpaper } from "../api/client";

// USER-RULED: Browse card mirrors the Library card — the card IS the thumbnail with a 2-line centered
// title overlay. Interactions (WE-style sidebar, 2026-11-10): click / right-click → focus (the Browse sidebar shows it:
// the preview, the numbers, Download & Apply); double-click → download & apply; the hover download button (bottom-right,
// where the Library card's trash sits) → download & apply; middle-click → open the source page/location.
// COOL: animated preview is a *layered* element kept mounted (opacity-toggled), not a src swap.
export const Card = memo(function Card({
  w, playing, selected, focused, inLibrary, progress, autoPlayGifs, onClick, onContext, onMiddle, onCancel, onDownload,
}: {
  w: Wallpaper; playing: boolean; selected: boolean; focused: boolean; inLibrary: boolean; progress: number | undefined; autoPlayGifs: boolean;
  onClick: (e: React.MouseEvent, w: Wallpaper) => void;
  onContext: (w: Wallpaper) => void; onMiddle: (w: Wallpaper) => void; onCancel: (w: Wallpaper) => void; onDownload: (w: Wallpaper) => void;
}) {
  const [hover, setHover] = useState(false);
  const active = hover || (autoPlayGifs && !!w.animatedThumbnailUrl);
  // keep the gif mounted once activated → re-hover never restarts it (just unhides the live frame)
  const [mounted, setMounted] = useState(false);
  useEffect(() => { if (active) setMounted(true); }, [active]);
  // A remote workshop preview's STATIC thumbnail is the
  // gif's frame-0, which is often pure black (fade-in loops). So AutoPlayGifs-off / the gif's loop-gap
  // showed black. For remote animated items use /still (first non-black/white frame); local items
  // already ship a real extracted thumbnail.
  const remoteAnim = !!w.animatedThumbnailUrl && /^https?:/i.test(w.animatedThumbnailUrl);
  const staticSrc = remoteAnim ? still(w.animatedThumbnailUrl!, CARD_STILL_W) : thumb(w.thumbnailUrl);
  const gifSrc = w.animatedThumbnailUrl ? anim(w.animatedThumbnailUrl) : null;
  const downloading = progress !== undefined;
  return (
    <div className={`card lib${playing ? " playing" : ""}${selected ? " selected" : ""}${focused ? " focused" : ""}`}>
      <div className="thumb-wrap" data-morph-id={`br-${w.pageUrl}`}
        onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
        onClick={(e) => onClick(e, w)}
        onDoubleClick={(e) => { if (!e.ctrlKey && !e.metaKey && !e.shiftKey) onDownload(w); }}
        onContextMenu={(e) => { e.preventDefault(); onContext(w); }}
        onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }} // stop middle-click autoscroll
        onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onMiddle(w); } }}
        title="Click: details · Double-click: download & apply · Middle-click: open source">
        <img className="thumb" src={staticSrc} loading="lazy" decoding="async" alt="" />
        {gifSrc && mounted && (
          // backgroundImage = the static frame → the gif's loop-gap shows the thumbnail, not black flicker
          <img className="thumb anim" src={gifSrc} decoding="async" alt=""
            style={{ opacity: active ? 1 : 0, backgroundImage: `url("${staticSrc}")`, backgroundSize: "cover", backgroundPosition: "center" }} />
        )}
        {w.isScene && <span className="badge">SCENE</span>}
        {/* already downloaded (the library holds it — Browse.tsx libraryKeys); top-right, the SCENE badge's opposite corner */}
        {inLibrary && <span className="badge inlib ico" data-in-library title="Already in your library"><Check size={11} strokeWidth={3} />In library</span>}
        {/* hover download button (bottom-right, the Library card's trash spot): the OUTLINE of a SOLID download glyph — we
            stroke a filled silhouette with no fill, so it traces the shape's inner+outer contour (hollow), breathing + glowing.
            It was a whole-card overlay while a click downloaded; a click now opens the sidebar. */}
        {!downloading && (
          <button className="dl-btn" title="Download & apply" onClick={(e) => { e.stopPropagation(); onDownload(w); }}
            onDoubleClick={(e) => e.stopPropagation()}>
            <svg className="dl-glyph" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path d="M19 9h-4V3H9v6H5l7 7 7-7z"
                stroke="currentColor" strokeWidth="0.85" strokeLinejoin="round" strokeLinecap="round" />
            </svg>
          </button>
        )}
        {downloading && (
          <div className="dl-overlay">
            <span className="dl-label">{progress! > 0 ? `${Math.round(progress! * 100)}%` : "Downloading…"}</span>
            <div className="dl-bar"><div className="dl-fill" style={{ width: `${Math.round((progress || 0) * 100)}%` }} /></div>
            <button className="dl-x" title="Cancel" onClick={(e) => { e.stopPropagation(); onCancel(w); }}><X size={14} /></button>
          </div>
        )}
        {/* bottom title bar, 2-line clamp, centered white (same as Library) */}
        <div className="lib-title" title={w.title}><span>{w.title}</span></div>
      </div>
    </div>
  );
});
