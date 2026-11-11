import { memo, useEffect, useRef, useState } from "react";
import { Check, X } from "lucide-react";
import { thumb, anim, still, CARD_STILL_W, type Wallpaper } from "../api/client";
import { useStore } from "../store";
import { shortDownloadStatus } from "./downloadStatus";

// USER-RULED: Browse card mirrors the Library card — the card IS the thumbnail with a 2-line centered
// title overlay. Interactions (docs/decisions.md § "Focus Browse cards on click, download on double-click"): click / right-click → focus (the Browse sidebar shows it:
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
  const dlStatus = useStore((s) => s.downloadStatus[w.pageUrl]); // PERF: this card's own slice
  // PERF: a removed <img> keeps loading (Chromium holds it alive until it's done); dropping its src aborts the request, so a
  // dropped list's thumbnails stop holding the backend's connections (store setSource). Guard: matrix browse:switchSource.
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const wrap = wrapRef.current;
    return () => { for (const i of wrap?.querySelectorAll("img") ?? []) if (!i.complete) i.removeAttribute("src"); };
  }, []);
  return (
    <div className={`card lib${playing ? " playing" : ""}${selected ? " selected" : ""}${focused ? " focused" : ""}`}>
      <div className="thumb-wrap" ref={wrapRef} data-morph-id={`br-${w.pageUrl}`}
        onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
        onClick={(e) => onClick(e, w)}
        onDoubleClick={(e) => { if (!e.ctrlKey && !e.metaKey && !e.shiftKey) onDownload(w); }}
        onContextMenu={(e) => { e.preventDefault(); onContext(w); }}
        onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }} // stop middle-click autoscroll
        onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onMiddle(w); } }}
       >
        <img className="thumb" src={staticSrc} loading="lazy" decoding="async" alt="" />
        {gifSrc && mounted && (
          // backgroundImage = the static frame → the gif's loop-gap shows the thumbnail, not black flicker
          <img className="thumb anim" src={gifSrc} decoding="async" alt=""
            style={{ opacity: active ? 1 : 0, backgroundImage: `url("${staticSrc}")`, backgroundSize: "cover", backgroundPosition: "center" }} />
        )}
        {w.isScene && <span className="badge">SCENE</span>}
        {/* already downloaded (the library holds it — Browse.tsx libraryKeys); top-right, the SCENE badge's opposite corner */}
        {inLibrary && <span className="badge inlib ico" data-in-library><Check size={11} strokeWidth={3} />In library</span>}
        {/* hover download button (bottom-right, the Library card's trash spot): a solid accent arrow on a dark round chip (index.css
            `.dl-btn` — a hollow outline gets lost on bright thumbnails). A click on the card opens the sidebar. */}
        {/* not on a card the library already has: it would only apply the library's copy — double-click / Enter / the sidebar's Apply do that */}
        {!downloading && !inLibrary && (
          <button className="dl-btn" title="Download & apply" onClick={(e) => { e.stopPropagation(); onDownload(w); }}
            onDoubleClick={(e) => e.stopPropagation()}>
            {/* two parts, so the arrow can drop into its tray on hover (components/iconMotion.ts). The arrow + tray span y 2.6–21.1
                (strokes included): the viewBox is shifted so THEIR centre is the box centre, not the paths' grid's.
                Guard: probe-steam look:dlCentre, probe-sidebar look:dlHover */}
            <svg className="dl-glyph" viewBox="0 -0.15 24 24" fill="none" aria-hidden>
              <path className="dl-arrow" d="M19 9h-4V3H9v6H5l7 7 7-7z"
                stroke="currentColor" strokeWidth="0.85" strokeLinejoin="round" strokeLinecap="round" />
              <path className="dl-tray" d="M3.5 15.5v2.5a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-2.5"
                fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" />
            </svg>
          </button>
        )}
        {downloading && (
          <div className="dl-overlay">
            <span className="dl-label" data-dl-label>{progress! > 0 ? `${Math.round(progress! * 100)}%` : shortDownloadStatus(dlStatus)}</span>
            {/* no percent → an indeterminate sweep, so a long wait never looks frozen */}
            <div className={`dl-bar${progress! > 0 ? "" : " indet"}`}><div className="dl-fill" style={progress! > 0 ? { width: `${Math.round(progress! * 100)}%` } : undefined} /></div>
            <button className="dl-x" aria-label="Cancel the download" onClick={(e) => { e.stopPropagation(); onCancel(w); }}><X size={14} /></button>
          </div>
        )}
        {/* bottom title bar, 2-line clamp, centered white (same as Library) */}
        <div className="lib-title" data-title={w.title}><span>{w.title}</span></div>
      </div>
    </div>
  );
});
