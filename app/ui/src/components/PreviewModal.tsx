import { useEffect, useReducer, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Monitor, Star, Heart, Eye, HardDrive, User, X, ExternalLink, Copy, Download, PlayCircle } from "lucide-react";
import { api, thumb, still, CARD_STILL_W, type Wallpaper } from "../api/client";
import { YouTubeEmbed } from "./YouTubeEmbed";

const fmt = (n: number | null) => (n == null ? null : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const fmtSize = (b: number | null) => {
  if (b == null) return null;
  if (b >= 1 << 30) return `${(b / (1 << 30)).toFixed(1)} GB`;
  if (b >= 1 << 20) return `${(b / (1 << 20)).toFixed(0)} MB`;
  return `${(b / 1024).toFixed(0)} KB`;
};

// COOL: the card thumbnail morphs into this modal via shared layoutId.
// Layer full-res (detail.previewUrl) under the gif so the enlarged view isn't soft.
export function PreviewModal({
  w, source, onClose, onDownload,
}: { w: Wallpaper | null; source: number; onClose: () => void; onDownload: (w: Wallpaper) => void }) {
  const [full, setFull] = useState<string | null>(null);
  const [fullReady, setFullReady] = useState(false);
  const [yt, setYt] = useState<string | null>(null); // attached YouTube trailer (from detail)
  const [ytPlaying, setYtPlaying] = useState(false);  // play it over the thumbnail stage
  // `morphed` gates the overlay layers (full-res + gif): they'd otherwise cover the morphing base
  // image instantly (gif items "don't morph"). Fade them in only after the morph completes.
  const [morphed, setMorphed] = useState(false);
  // Kick one re-render the frame after open so framer-motion runs the layoutId enter projection
  // immediately (otherwise the morph waits for the async detail fetch's re-render → modal pops full
  // first, then morphs ~165ms late).
  const [, force] = useReducer((x: number) => x + 1, 0);

  useEffect(() => {
    setFull(null); setFullReady(false); setMorphed(false); setYt(null); setYtPlaying(false);
    if (!w) return;
    let alive = true;
    const raf = requestAnimationFrame(() => force());
    const mt = setTimeout(() => setMorphed(true), 340); // ~morph duration
    api.detail(source, w).then((d) => { if (!alive) return; if (d.previewUrl) setFull(d.previewUrl); setYt(d.youtubeUrl); }).catch(() => {});
    return () => { alive = false; cancelAnimationFrame(raf); clearTimeout(mt); };
  }, [w, source]);

  return (
    <AnimatePresence>
      {w && (
        <motion.div className="modal-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          onClick={onClose}>
          {/* plain div — NO animating motion wrapper around the shared image, else its ENTER layout
              projection (card→preview morph) snaps. Backdrop fades; image morphs; body fades. */}
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-stage">
              {/* base: morph anchor (small thumb, instant) — match Card's static src (the /still frame for
                  remote animated items) so the morph doesn't swap image sources mid-animation */}
              <motion.img layoutId={`thumb-${w.pageUrl}`} className="modal-img"
                src={w.animatedThumbnailUrl && /^https?:/i.test(w.animatedThumbnailUrl) ? still(w.animatedThumbnailUrl, CARD_STILL_W) : thumb(w.thumbnailUrl)}
                alt="" style={{ borderRadius: 14 }} />
              {/* full-res static, fades in over the base AFTER the morph. PERF: only MOUNT it once
                  morphed — mounting sets src → the browser decodes the large image on the main thread,
                  which mid-morph hitches the animation. Deferring the mount pushes that decode past the
                  morph window so the morph only animates the already-cached small thumb (butter). */}
              {full && morphed && <img className="modal-img layer" style={{ opacity: fullReady ? 1 : 0 }}
                src={thumb(full, w.pageUrl)} onLoad={() => setFullReady(true)} alt="" />}
              {/* animated gif on top — likewise mounted only after the morph (its decode would hitch too) */}
              {morphed && w.animatedThumbnailUrl && <img className="modal-img layer" style={{ opacity: 1 }} src={thumb(w.animatedThumbnailUrl)} alt="" />}
              {ytPlaying && yt && <YouTubeEmbed url={yt} onClose={() => setYtPlaying(false)} />}
            </div>
            <motion.div className="modal-body" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.08, duration: 0.2 }}>
              <h2>{w.title}</h2>
              <div className="meta">
                {w.resolution && <span className="mrow"><Monitor size={14} /> {w.resolution}</span>}
                {fmt(w.subscriptions) && <span className="mrow"><Star size={14} /> {fmt(w.subscriptions)} subs</span>}
                {fmt(w.favorites) && <span className="mrow"><Heart size={14} /> {fmt(w.favorites)}</span>}
                {fmt(w.views) && <span className="mrow"><Eye size={14} /> {fmt(w.views)}</span>}
                {fmtSize(w.fileSizeBytes) && <span className="mrow"><HardDrive size={14} /> {fmtSize(w.fileSizeBytes)}</span>}
                {w.authorName && <span className="mrow"><User size={14} /> {w.authorName}</span>}
                {w.isScene && <span className="badge">SCENE</span>}
              </div>
              {w.description && <p className="desc">{w.description}</p>}
              {w.tags && w.tags.length > 0 && (
                <div className="tags">{w.tags.slice(0, 12).map((t) => <span key={t} className="tag">{t}</span>)}</div>
              )}
              <div className="modal-actions">
                <button className="btn accent ico" onClick={() => { onDownload(w); onClose(); }}><Download size={15} /> Download &amp; Apply</button>
                {yt && (
                  <button className="btn ghost ico" onClick={() => setYtPlaying((p) => !p)}><PlayCircle size={15} /> {ytPlaying ? "Hide trailer" : "Play YouTube"}</button>
                )}
                {w.workshopId && (
                  <a className="btn ghost ico" href={`https://steamcommunity.com/sharedfiles/filedetails/?id=${w.workshopId}`}
                    target="_blank" rel="noreferrer"><ExternalLink size={14} /> Open on Steam</a>
                )}
                {w.workshopId && (
                  <button className="btn ghost ico" onClick={() => navigator.clipboard?.writeText(w.workshopId!)}><Copy size={14} /> Copy ID</button>
                )}
                <button className="btn ghost ico" onClick={onClose}><X size={14} /> Close</button>
              </div>
            </motion.div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
