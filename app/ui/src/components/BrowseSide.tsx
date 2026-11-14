import { useEffect, useState } from "react";
import { Monitor, Star, Users, HardDrive, User, ExternalLink, Download, CloudDownload, Check, Library as LibraryIcon, Play, X, Info } from "lucide-react";
import { api, thumb, still, anim, CARD_STILL_W, type LibraryItem, type Wallpaper } from "../api/client";
import { SideMedia, SideSection } from "./SidePanel";
import { usePreview, useOnline } from "./sidePreview";
import { useStore } from "../store";
import { SubToggle } from "./SubToggle";
import { isWorkshopItem, subscribeIsDownload } from "./subscribeMode";
import { FolderFlap } from "./icons";
import { magnetRef } from "./magnet";
import { sideTags } from "./sideTags";
import { WorkshopIdPill } from "./WorkshopIdPill";
import { CommentsSection, CreatorRow, FavoriteTile } from "./WorkshopSocial";

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
  // "open in your own player" only for a file on this machine (a local Wallpaper Engine folder's item); a Workshop preview is
  // a remote URL, never sent as a path, and its media-cache copy isn't offered: the user asked for the item's media, not
  // whatever part of it the cache holds
  const localFile = (u: string | null | undefined) => (u && u.startsWith("/") ? u : null);
  const files = { video: previewVid ? localFile(detail?.full) : null, gif: localFile(w.animatedThumbnailUrl),
    image: localFile(detail?.full && !previewVid ? detail.full : w.thumbnailUrl) };
  const online = useOnline();
  const preview = usePreview("browse", { gif: !!gifSrc, video: !!previewVid, youtube: !!yt && online });
  // the previews' default level: the volume this wallpaper would play at — its library copy's own, else the global one
  const globalVolume = useStore((s) => (s.settings?.volume as number) ?? 100);
  const wall = libItem?.volumeOverride ?? globalVolume;
  const downloading = progress !== undefined;
  // a Workshop download's step in words (WS download-progress `status`) — e.g. "Click Subscribe in Steam, then it downloads by
  // itself…" while it waits on the Steam app (WorkshopDownloader)
  const dlStatus = useStore((s) => s.downloadStatus[w.pageUrl]);
  const web = w.pageUrl.startsWith("http");
  const openOnSteam = useStore((s) => s.openOnSteam);
  // auto-import on + the "subscribe" download mode: a subscription lands in the library anyway, so Download IS Subscribe —
  // the buttons say so, and the subscription card shows only once subscribed (SubToggle only="subscribed"). The other modes
  // (the Steam app / page, a steamcmd copy) keep Download and the card. Guard: probe-steam steam:subMerge:*
  const subIsDownload = useStore((s) => subscribeIsDownload(s.settings)) && isWorkshopItem(w);
  const GetIcon = subIsDownload ? CloudDownload : Download;
  // the About card only for a description; tags alone sit in a plain row (a card for one property looks odd)
  const tags = sideTags(w.tags, { resolution: !!w.resolution });
  const tagRow = tags.length > 0 ? <div className="tags side-tags">{tags.map((t) => <span key={t} className="tag">{t}</span>)}</div> : null;

  return (
    <>
      <SideMedia id={w.pageUrl} cardId={`br-${w.pageUrl}`} base={baseSrc} full={fullSrc} gif={gifSrc} video={previewVid} youtube={yt} preview={preview} wall={wall} files={files} />
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
          {/* Steam's current counts (the backend reads `subscriptions` / `favorited`, never the lifetime ones — Guard:
              test-workshop-social.sh); the star is the favourite's everywhere (the Favourite tile below), the people the
              subscribers'. Guard: probe-steam ws:counts */}
          {fmt(w.subscriptions) && <span className="side-pill" title="Subscribers" data-side-stat="subscribers"><Users size={13} /> {fmt(w.subscriptions)}</span>}
          {fmt(w.favorites) && <span className="side-pill" title="Favourites" data-side-stat="favorites"><Star size={13} /> {fmt(w.favorites)}</span>}
          {fmtSize(w.fileSizeBytes) && <span className="side-pill" title="Size"><HardDrive size={13} /> {fmtSize(w.fileSizeBytes)}</span>}
          {w.authorName && !w.workshopId && <span className="side-pill" title="Author"><User size={13} /> {w.authorName}</span>}
          {w.workshopId && <WorkshopIdPill id={w.workshopId} />}
        </div>
        {/* who made it — a click lists all of their wallpapers in Browse */}
        {w.workshopId && <CreatorRow workshopId={w.workshopId} authorId={w.authorId} />}
        {/* the download buttons: the only way to download from here — the arrow drops into its tray on hover (components/iconMotion.ts) */}
        <div className="side-cta">
          {downloading ? (
            <div className="side-dl" data-side-download>
              <span className="shint" data-side-download-status>{progress! > 0 ? `Downloading ${Math.round(progress! * 100)}%` : dlStatus || "Downloading…"}</span>
              <div className="dl-bar"><div className="dl-fill" style={{ width: `${Math.round((progress || 0) * 100)}%` }} /></div>
              <button className="btn ghost ico" onClick={onCancel}><X size={14} /> Cancel</button>
            </div>
          ) : libItem ? (
            <button className="btn accent ico side-go" ref={magnetRef} onClick={() => onApplyLib(libItem.videoPath)}><Play size={15} fill="currentColor" /> Apply</button>
          ) : (
            <>
              <button className="btn accent ico side-go" data-side-get="apply" ref={magnetRef} onClick={() => onDownload(true)}><span className="side-dl-ico"><GetIcon size={16} /></span> {subIsDownload ? "Subscribe" : "Download"} &amp; Apply</button>
              <button className="btn ghost ico side-go" data-side-get="only" onClick={() => onDownload(false)}><span className="side-dl-ico"><GetIcon size={15} /></span> {subIsDownload ? "Subscribe" : "Download"}</button>
            </>
          )}
        </div>
        {/* a Workshop item's subscription (Browse > Wallpaper Engine (Local) and (Workshop)) — Subscribe / Unsubscribe */}
        {w.workshopId && <SubToggle id={w.workshopId} title={w.title} weLocal={!web} only={subIsDownload ? "subscribed" : undefined} likely={!!libItem} />}
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
            <button className="side-tile" onClick={onOpenSource}>{web ? <><span className="side-tile-ico"><ExternalLink size={15} /></span>Open page</> : <><span className="side-tile-ico"><FolderFlap size={15} /></span>Open in file manager</>}</button>
          )}
          {w.workshopId && <FavoriteTile workshopId={w.workshopId} />}
        </div>
        {/* read once it scrolls into view: the sidebar's open asks Steam for nothing more */}
        {w.workshopId && <CommentsSection workshopId={w.workshopId} authorId={w.authorId} />}
      </div>
    </>
  );
}
