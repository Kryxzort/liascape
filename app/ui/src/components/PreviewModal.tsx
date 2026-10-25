import { useEffect, useState } from "react";
import { Monitor, Star, Heart, Eye, HardDrive, User, X, ExternalLink, Copy, Download, PlayCircle } from "lucide-react";
import { api, thumb, still, anim, CARD_STILL_W, type Wallpaper } from "../api/client";
import { YouTubeEmbed } from "./YouTubeEmbed";
import { captureSource } from "./morph";
import { useMorph } from "./useMorph";

const fmt = (n: number | null) => (n == null ? null : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const fmtSize = (b: number | null) => {
  if (b == null) return null;
  if (b >= 1 << 30) return `${(b / (1 << 30)).toFixed(1)} GB`;
  if (b >= 1 << 20) return `${(b / (1 << 20)).toFixed(0)} MB`;
  return `${(b / 1024).toFixed(0)} KB`;
};

// COOL: morphs out of its Browse card and back into it (components/useMorph.ts — one uniform scale
// + a re-crop, never stretched); the gif keeps playing through it (the card's own /anim URL = the same
// image, the same animation). Full-res (detail.previewUrl) layers in once it landed so it isn't soft.
export function PreviewModal({
  w, source, onClose, onDownload,
}: { w: Wallpaper | null; source: number; onClose: () => void; onDownload: (w: Wallpaper) => void }) {
  const [detail, setDetail] = useState<{ url: string; full: string | null; yt: string | null } | null>(null);
  const [fullFor, setFullFor] = useState<string | null>(null); // the full-res layer shows once IT loaded
  const [ytFor, setYtFor] = useState<string | null>(null);     // the trailer playing over the stage (per item)
  // the picture's own aspect: the card's still knows it at the click; else 16:9 until the base loads
  const [loaded, setLoaded] = useState<{ url: string; aspect: number } | null>(null);
  const [srcAspect, setSrcAspect] = useState<{ url: string; aspect: number | null } | null>(null);

  // the card's picture state, read before the modal's first layout (the card is still on screen)
  const pageUrl = w?.pageUrl ?? null;
  if (pageUrl && srcAspect?.url !== pageUrl) setSrcAspect({ url: pageUrl, aspect: captureSource(`br-${pageUrl}`).aspect });
  const known = (srcAspect?.url === pageUrl ? srcAspect?.aspect : null) ?? (loaded?.url === pageUrl ? loaded?.aspect : null) ?? null;
  const aspect = known ?? 16 / 9;
  const { panelRef, mediaRef, ghostRef, bodyRef, requestClose, landed } = useMorph({ open: w, ready: known != null, morphId: pageUrl ? `br-${pageUrl}` : null, aspect, onClose });

  useEffect(() => {
    if (!w) return;
    let alive = true;
    api.detail(source, w).then((d) => { if (alive) setDetail({ url: w.pageUrl, full: d.previewUrl ?? null, yt: d.youtubeUrl ?? null }); }).catch(() => {});
    return () => { alive = false; };
  }, [w, source]);

  if (!w) return null;
  const d = detail?.url === w.pageUrl ? detail : null;
  const yt = d?.yt ?? null;
  const ytPlaying = ytFor === w.pageUrl;
  // the same static the card shows (a /still frame for remote animated items — frame 0 is often black)
  const baseSrc = w.animatedThumbnailUrl && /^https?:/i.test(w.animatedThumbnailUrl) ? still(w.animatedThumbnailUrl, CARD_STILL_W) : thumb(w.thumbnailUrl);
  const fullSrc = d?.full ? thumb(d.full, w.pageUrl) : null;
  const gifSrc = w.animatedThumbnailUrl ? anim(w.animatedThumbnailUrl) : null;

  return (
    <div className="modal-backdrop" onClick={requestClose}>
      <div className="morph-ghost" ref={ghostRef} />
      <div className="modal morph-panel" ref={panelRef} onClick={(e) => e.stopPropagation()}>
        <div className="modal-stage">
          <div className="morph-media" data-morph-media ref={mediaRef}
            style={{ aspectRatio: String(aspect), width: `min(100%, calc(62vh * ${aspect}))` }}>
            <img src={baseSrc} alt=""
              onLoad={(e) => { const i = e.currentTarget; if (i.naturalWidth) setLoaded({ url: w.pageUrl, aspect: i.naturalWidth / i.naturalHeight }); }} />
            {/* PERF: mounted once landed — its (large) decode mid-flight would hitch the morph */}
            {fullSrc && landed && <img className={`mm-full${fullFor === fullSrc ? " on" : ""}`} src={fullSrc} alt="" onLoad={() => setFullFor(fullSrc)} />}
            {gifSrc && <img className="mm-anim" src={gifSrc} alt="" />}
          </div>
          {ytPlaying && yt && <YouTubeEmbed url={yt} onClose={() => setYtFor(null)} />}
        </div>
        <div className="modal-body" ref={bodyRef}>
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
            <button className="btn accent ico" onClick={() => { onDownload(w); requestClose(); }}><Download size={15} /> Download &amp; Apply</button>
            {yt && (
              <button className="btn ghost ico" onClick={() => setYtFor(ytPlaying ? null : w.pageUrl)}><PlayCircle size={15} /> {ytPlaying ? "Hide trailer" : "Play YouTube"}</button>
            )}
            {w.workshopId && (
              <a className="btn ghost ico" href={`https://steamcommunity.com/sharedfiles/filedetails/?id=${w.workshopId}`}
                target="_blank" rel="noreferrer"><ExternalLink size={14} /> Open on Steam</a>
            )}
            {w.workshopId && (
              <button className="btn ghost ico" onClick={() => navigator.clipboard?.writeText(w.workshopId!)}><Copy size={14} /> Copy ID</button>
            )}
            <button className="btn ghost ico" onClick={requestClose}><X size={14} /> Close</button>
          </div>
        </div>
      </div>
    </div>
  );
}
