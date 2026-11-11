import { useEffect, useState } from "react";
import { Monitor, Star, Heart, Eye, HardDrive, User, ExternalLink, Copy, Download, Check, Library as LibraryIcon, Play, X, FolderOpen, Info } from "lucide-react";
import { api, thumb, still, anim, CARD_STILL_W, type LibraryItem, type Wallpaper } from "../api/client";
import { SideMedia, SideSection } from "./SidePanel";
import { usePreview, useOnline } from "./sidePreview";
import { useStore } from "../store";
import { SubToggle } from "./SubToggle";

const VIDEO_RE = /\.(mp4|webm|mov|mkv|avi)$/i;

const fmt = (n: number | null) => (n == null ? null : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const fmtSize = (b: number | null) => {
  if (b == null) return null;
  if (b >= 1 << 30) return `${(b / (1 << 30)).toFixed(1)} GB`;
  if (b >= 1 << 20) return `${(b / (1 << 20)).toFixed(0)} MB`;
  return `${(b / 1024).toFixed(0)} KB`;
};

// The Browse sidebar's content (components/SidePanel.tsx is the shell) — what the preview modal had: the picture (the
// card's still → the full-res preview, `api.detail`, fading in once loaded → the gif, the card's own /anim URL), the
// numbers, the description and tags, the trailer (the picture's preview switch), Steam / the source page; plus Download &
// Apply, Download only, the
// download's progress + Cancel, and the "In library" badge's info: an item the library already holds says so, plays its
// library copy (Apply) and can be shown there. Mounted per item (keyed by its page URL in SidePanel).
export function BrowseSide({ w, source, libItem, progress, onDownload, onCancel, onApplyLib, onShowInLibrary, onOpenSource }: {
  w: Wallpaper; source: number; libItem: LibraryItem | null; progress: number | undefined;
  onDownload: (apply: boolean) => void; onCancel: () => void; onApplyLib: (path: string) => void; onShowInLibrary: (path: string) => void;
  onOpenSource: () => void;
}) {
  const [detail, setDetail] = useState<{ full: string | null; yt: string | null } | null>(null);
  useEffect(() => {
    let alive = true;
    api.detail(source, w).then((d) => { if (alive) setDetail({ full: d.previewUrl ?? null, yt: d.youtubeUrl ?? null }); }).catch(() => {});
    return () => { alive = false; };
  }, [w.pageUrl, source]); // eslint-disable-line react-hooks/exhaustive-deps

  const yt = detail?.yt ?? null;
  // the same static the card shows (a /still frame for remote animated items — frame 0 is often black)
  const baseSrc = w.animatedThumbnailUrl && /^https?:/i.test(w.animatedThumbnailUrl) ? still(w.animatedThumbnailUrl, CARD_STILL_W) : thumb(w.thumbnailUrl);
  // the detail's preview: a full-res image — or a preview VIDEO (the preview switch's "Video"), never put in an <img>
  const previewVid = detail?.full && VIDEO_RE.test(detail.full.split("?")[0]) ? thumb(detail.full, w.pageUrl) : null;
  const fullSrc = detail?.full && !previewVid ? thumb(detail.full, w.pageUrl) : null;
  const gifSrc = w.animatedThumbnailUrl ? anim(w.animatedThumbnailUrl) : null;
  const online = useOnline();
  const preview = usePreview("browse", { gif: !!gifSrc, video: !!previewVid, youtube: !!yt && online });
  const downloading = progress !== undefined;
  // a Workshop download's step in words (WS download-progress `status`) — e.g. "Not signed in to Steam here — click Subscribe in
  // Steam, then it downloads by itself…" while it waits on the Steam app (WorkshopDownloader)
  const dlStatus = useStore((s) => s.downloadStatus[w.pageUrl]);
  const web = w.pageUrl.startsWith("http");
  const openOnSteam = useStore((s) => s.openOnSteam);
  // the About card only for a description; tags alone sit in a plain row (owner 2026-11-11: a card for one property felt strange)
  const tagRow = w.tags && w.tags.length > 0 ? <div className="tags side-tags">{w.tags.slice(0, 12).map((t) => <span key={t} className="tag">{t}</span>)}</div> : null;

  return (
    <>
      <SideMedia id={w.pageUrl} cardId={`br-${w.pageUrl}`} base={baseSrc} full={fullSrc} gif={gifSrc} video={previewVid} youtube={yt} preview={preview} />
      <div className="side-body">
        <div className="side-hero">
          {libItem && (
            <span className="side-state" data-in-library>
              <span className="side-chip inlib"><Check size={12} strokeWidth={3} /> In your library</span>
              <button className="mini ico side-link" onClick={() => onShowInLibrary(libItem.videoPath)}><LibraryIcon size={13} /> Show in Library</button>
            </span>
          )}
          {w.isScene && <span className="side-chip accent">SCENE</span>}
          {w.resolution && <span className="side-pill"><Monitor size={13} /> {w.resolution}</span>}
          {fmt(w.subscriptions) && <span className="side-pill" title="Subscriptions"><Star size={13} /> {fmt(w.subscriptions)}</span>}
          {fmt(w.favorites) && <span className="side-pill" title="Favourites"><Heart size={13} /> {fmt(w.favorites)}</span>}
          {fmt(w.views) && <span className="side-pill" title="Views"><Eye size={13} /> {fmt(w.views)}</span>}
          {fmtSize(w.fileSizeBytes) && <span className="side-pill" title="Size"><HardDrive size={13} /> {fmtSize(w.fileSizeBytes)}</span>}
          {w.authorName && <span className="side-pill" title="Author"><User size={13} /> {w.authorName}</span>}
        </div>
        {/* the download buttons: the only way to download from here — the glyph nudges down on hover (index.css .side-cta) */}
        <div className="side-cta">
          {downloading ? (
            <div className="side-dl" data-side-download>
              <span className="shint" data-side-download-status>{progress! > 0 ? `Downloading ${Math.round(progress! * 100)}%` : dlStatus || "Downloading…"}</span>
              <div className="dl-bar"><div className="dl-fill" style={{ width: `${Math.round((progress || 0) * 100)}%` }} /></div>
              <button className="btn ghost ico" onClick={onCancel}><X size={14} /> Cancel</button>
            </div>
          ) : libItem ? (
            <button className="btn accent ico side-go" onClick={() => onApplyLib(libItem.videoPath)}><Play size={15} fill="currentColor" /> Apply</button>
          ) : (
            <>
              <button className="btn accent ico side-go" onClick={() => onDownload(true)}><span className="side-dl-ico"><Download size={16} /></span> Download &amp; Apply</button>
              <button className="btn ghost ico side-go" onClick={() => onDownload(false)}><span className="side-dl-ico"><Download size={15} /></span> Download</button>
            </>
          )}
        </div>
        {/* a Workshop item's subscription (Browse > Wallpaper Engine (Local) and (Workshop)) — Subscribe / Unsubscribe */}
        {w.workshopId && <SubToggle id={w.workshopId} title={w.title} weLocal={!web} />}
        {w.description ? (
          <SideSection icon={<Info size={15} />} title="About">
            <p className="desc">{w.description}</p>
            {tagRow}
          </SideSection>
        ) : tagRow}
        <div className="side-tiles">
          {w.workshopId ? (
            // the Steam CLIENT (steam://…, POST /steam/open-page); the https page in the browser when that couldn't be opened
            <button className="side-tile" data-open-steam onClick={() => openOnSteam(w.workshopId!)}><span className="side-tile-ico"><ExternalLink size={15} /></span>Open on Steam</button>
          ) : (
            // the middle-click target: the page it came from, or a local folder
            <button className="side-tile" onClick={onOpenSource}>{web ? <><span className="side-tile-ico"><ExternalLink size={15} /></span>Open page</> : <><span className="side-tile-ico"><FolderOpen size={15} /></span>Open in file manager</>}</button>
          )}
          {w.workshopId && <button className="side-tile" onClick={() => navigator.clipboard?.writeText(w.workshopId!)}><span className="side-tile-ico"><Copy size={15} /></span>Copy ID</button>}
        </div>
      </div>
    </>
  );
}
