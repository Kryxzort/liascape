import { useEffect, useState } from "react";
import { Monitor, Star, Heart, Eye, HardDrive, User, ExternalLink, Copy, Download, PlayCircle, Check, Library as LibraryIcon, Play, X, FolderOpen } from "lucide-react";
import { api, thumb, still, anim, CARD_STILL_W, type LibraryItem, type Wallpaper } from "../api/client";
import { YouTubeEmbed } from "./YouTubeEmbed";
import { SideMedia } from "./SidePanel";

const fmt = (n: number | null) => (n == null ? null : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const fmtSize = (b: number | null) => {
  if (b == null) return null;
  if (b >= 1 << 30) return `${(b / (1 << 30)).toFixed(1)} GB`;
  if (b >= 1 << 20) return `${(b / (1 << 20)).toFixed(0)} MB`;
  return `${(b / 1024).toFixed(0)} KB`;
};

// The Browse sidebar's content (components/SidePanel.tsx is the shell) — what the preview modal had: the picture (the
// card's still → the full-res preview, `api.detail`, fading in once loaded → the gif, the card's own /anim URL), the
// numbers, the description and tags, the trailer, Steam / the source page; plus Download & Apply, Download only, the
// download's progress + Cancel, and the "In library" badge's info: an item the library already holds says so, plays its
// library copy (Apply) and can be shown there. Mounted per item (keyed by its page URL in SidePanel).
export function BrowseSide({ w, source, libItem, progress, onDownload, onCancel, onApplyLib, onShowInLibrary, onOpenSource }: {
  w: Wallpaper; source: number; libItem: LibraryItem | null; progress: number | undefined;
  onDownload: (apply: boolean) => void; onCancel: () => void; onApplyLib: (path: string) => void; onShowInLibrary: (path: string) => void;
  onOpenSource: () => void;
}) {
  const [detail, setDetail] = useState<{ full: string | null; yt: string | null } | null>(null);
  const [ytPlaying, setYtPlaying] = useState(false);
  useEffect(() => {
    let alive = true;
    api.detail(source, w).then((d) => { if (alive) setDetail({ full: d.previewUrl ?? null, yt: d.youtubeUrl ?? null }); }).catch(() => {});
    return () => { alive = false; };
  }, [w.pageUrl, source]); // eslint-disable-line react-hooks/exhaustive-deps

  const yt = detail?.yt ?? null;
  // the same static the card shows (a /still frame for remote animated items — frame 0 is often black)
  const baseSrc = w.animatedThumbnailUrl && /^https?:/i.test(w.animatedThumbnailUrl) ? still(w.animatedThumbnailUrl, CARD_STILL_W) : thumb(w.thumbnailUrl);
  const fullSrc = detail?.full ? thumb(detail.full, w.pageUrl) : null;
  const gifSrc = w.animatedThumbnailUrl ? anim(w.animatedThumbnailUrl) : null;
  const downloading = progress !== undefined;
  const web = w.pageUrl.startsWith("http");

  return (
    <>
      <SideMedia id={w.pageUrl} cardId={`br-${w.pageUrl}`} base={baseSrc} full={fullSrc} gif={gifSrc} video={null}
        overlay={ytPlaying && yt ? <YouTubeEmbed url={yt} onClose={() => setYtPlaying(false)} /> : null} />
      <div className="side-body">
        {libItem && (
          <div className="side-state" data-in-library>
            <span className="side-chip inlib"><Check size={12} strokeWidth={3} /> In your library</span>
            <button className="mini ico" onClick={() => onShowInLibrary(libItem.videoPath)}><LibraryIcon size={13} /> Show in Library</button>
          </div>
        )}
        {w.isScene && <div className="side-state"><span className="side-chip">SCENE</span></div>}
        <div className="side-actions primary">
          {downloading ? (
            <div className="side-dl" data-side-download>
              <span className="shint">{progress! > 0 ? `Downloading ${Math.round(progress! * 100)}%` : "Downloading…"}</span>
              <div className="dl-bar"><div className="dl-fill" style={{ width: `${Math.round((progress || 0) * 100)}%` }} /></div>
              <button className="btn ghost ico" onClick={onCancel}><X size={14} /> Cancel</button>
            </div>
          ) : libItem ? (
            <button className="btn accent ico" onClick={() => onApplyLib(libItem.videoPath)} title="Play the copy in your library"><Play size={14} fill="currentColor" /> Apply</button>
          ) : (
            <>
              <button className="btn accent ico" onClick={() => onDownload(true)} title="Download it to your library and play it (double-click / Enter)"><Download size={15} /> Download &amp; Apply</button>
              <button className="btn ghost ico" onClick={() => onDownload(false)} title="Download it to your library only"><Download size={14} /> Download</button>
            </>
          )}
        </div>
        <div className="meta">
          {w.resolution && <span className="mrow"><Monitor size={14} /> {w.resolution}</span>}
          {fmt(w.subscriptions) && <span className="mrow"><Star size={14} /> {fmt(w.subscriptions)} subs</span>}
          {fmt(w.favorites) && <span className="mrow"><Heart size={14} /> {fmt(w.favorites)}</span>}
          {fmt(w.views) && <span className="mrow"><Eye size={14} /> {fmt(w.views)}</span>}
          {fmtSize(w.fileSizeBytes) && <span className="mrow"><HardDrive size={14} /> {fmtSize(w.fileSizeBytes)}</span>}
          {w.authorName && <span className="mrow"><User size={14} /> {w.authorName}</span>}
        </div>
        {w.description && <p className="desc">{w.description}</p>}
        {w.tags && w.tags.length > 0 && (
          <div className="tags">{w.tags.slice(0, 12).map((t) => <span key={t} className="tag">{t}</span>)}</div>
        )}
        <div className="side-actions">
          {yt && <button className="btn ghost ico" onClick={() => setYtPlaying((x) => !x)}><PlayCircle size={15} /> {ytPlaying ? "Hide trailer" : "Play YouTube"}</button>}
          {w.workshopId ? (
            <a className="btn ghost ico" href={`https://steamcommunity.com/sharedfiles/filedetails/?id=${w.workshopId}`} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Open on Steam</a>
          ) : (
            // the middle-click target: the page it came from, or a local folder
            <button className="btn ghost ico" onClick={onOpenSource}>{web ? <><ExternalLink size={14} /> Open page</> : <><FolderOpen size={14} /> Open in file manager</>}</button>
          )}
          {w.workshopId && <button className="btn ghost ico" onClick={() => navigator.clipboard?.writeText(w.workshopId!)}><Copy size={14} /> Copy ID</button>}
        </div>
      </div>
    </>
  );
}
