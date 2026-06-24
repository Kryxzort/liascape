import { memo, useEffect, useState } from "react";
import { motion } from "framer-motion";
import { X } from "lucide-react";
import { thumb, anim, still, CARD_STILL_W, type Wallpaper } from "../api/client";

// USER-RULED: Browse card mirrors the Library card — the card IS the thumbnail with a 2-line centered
// title overlay. Interactions: hover → download icon (click downloads + applies); left/right-click →
// preview/more-info modal; middle-click → open the source page/location.
// COOL: animated preview is a *layered* element kept mounted (opacity-toggled), not a src swap.
export const Card = memo(function Card({
  w, playing, selected, progress, autoPlayGifs, previewing, onClick, onContext, onMiddle, onCancel,
}: {
  w: Wallpaper; playing: boolean; selected: boolean; progress: number | undefined; autoPlayGifs: boolean;
  previewing: boolean;
  onClick: (e: React.MouseEvent, w: Wallpaper) => void;
  onContext: (w: Wallpaper) => void; onMiddle: (w: Wallpaper) => void; onCancel: (w: Wallpaper) => void;
}) {
  const [hover, setHover] = useState(false);
  // hide the overlay while this card is the open preview AND through the close-morph (no double gif /
  // snap-back as the modal morphs shut)
  const [cooldown, setCooldown] = useState(false);
  useEffect(() => {
    if (previewing) { setCooldown(true); return; }
    const t = setTimeout(() => setCooldown(false), 360);
    return () => clearTimeout(t);
  }, [previewing]);
  const active = !previewing && !cooldown && (hover || (autoPlayGifs && !!w.animatedThumbnailUrl));
  const morphing = previewing || cooldown;
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
    <div className={`card lib${playing ? " playing" : ""}${selected ? " selected" : ""}${morphing ? " morphing" : ""}`}>
      <div className="thumb-wrap"
        onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
        onClick={(e) => onClick(e, w)}
        onContextMenu={(e) => { e.preventDefault(); onContext(w); }}
        onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }} // stop middle-click autoscroll
        onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onMiddle(w); } }}
        title="Click: download & apply · Right-click: info · Middle-click: open source">
        {/* only the morphing card is a framer layout node (else hundreds bog down the morph) */}
        {morphing
          ? <motion.img layoutId={`thumb-${w.pageUrl}`} className="thumb" src={staticSrc} loading="lazy" decoding="async" alt="" style={{ borderRadius: 14 }} />
          : <img className="thumb" src={staticSrc} loading="lazy" decoding="async" alt="" />}
        {gifSrc && mounted && (
          // backgroundImage = the static frame → the gif's loop-gap shows the thumbnail, not black flicker
          <img className="thumb anim" src={gifSrc} decoding="async" alt=""
            style={{ opacity: active ? 1 : 0, backgroundImage: `url("${staticSrc}")`, backgroundSize: "cover", backgroundPosition: "center" }} />
        )}
        {w.isScene && <span className="badge">SCENE</span>}
        {/* hover affordance: the OUTLINE of a SOLID download glyph — we stroke a filled silhouette with
            no fill, so it traces the shape's inner+outer contour (hollow). pointer-events:none. */}
        {!downloading && (
          <div className="dl-ico" aria-hidden>
            <svg className="dl-glyph" viewBox="0 0 24 24" fill="none">
              <path d="M19 9h-4V3H9v6H5l7 7 7-7z"
                stroke="currentColor" strokeWidth="0.85" strokeLinejoin="round" strokeLinecap="round" />
            </svg>
          </div>
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
