import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Monitor, User, ExternalLink, Download, CloudDownload, Check, Library as LibraryIcon, Play, X, Info } from "lucide-react";
import { api, thumb, still, anim, CARD_STILL_W, type LibraryItem, type OneOffRoute, type Wallpaper } from "../api/client";
import { SideMedia, SideSection } from "./SidePanel";
import { usePreview, useOnline } from "./sidePreview";
import { useStore } from "../store";
import { SubToggle } from "./SubToggle";
import { actionBlocked, downloadHint, isWorkshopItem, subscribeIsDownload } from "./subscribeMode";
import { FolderFlap } from "./icons";
import { magnetRef } from "./magnet";
import { sideTags } from "./sideTags";
import { WorkshopIdPill } from "./WorkshopIdPill";
import { BaseRow, CommentsSection, CreatorRow, FavoriteTile, PresetsRow } from "./WorkshopSocial";
import { SizePill, StatPills } from "./sidePills";
import { ContextMenu, type MenuAt } from "./ContextMenu";
import { menuAt, oneOffMenuItem } from "./menuItems";
import { FADE, useMotion } from "./motion";

// how long an asked "Download without subscribing" route stays good when nothing it hangs on changed here (a settings change in
// another window moves it)
const ONE_OFF_FRESH_MS = 5000;

const VIDEO_RE = /\.(mp4|webm|mov|mkv|avi)$/i;

// The Browse sidebar's content (components/SidePanel.tsx is the shell) — what the preview modal had: the picture (the
// card's still → the full-res preview, `api.detail`, fading in once loaded → the gif, the card's own /anim URL), the
// numbers, the description and tags, the trailer (the picture's preview switch), Steam / the source page; plus Download &
// Apply, Download only, the
// download's progress + Cancel, and the "In library" badge's info: an item the library already holds says so, plays its
// library copy (Apply) and can be shown there. Mounted per item (keyed by its page URL in SidePanel).
export function BrowseSide({ w, source, libItem, progress, onDownload, onCancel, onApplyLib, onShowInLibrary, onOpenSource }: {
  w: Wallpaper; source: number; libItem: LibraryItem | null; progress: number | undefined;
  onDownload: (apply: boolean, oneOff?: boolean) => void; onCancel: () => void; onApplyLib: (path: string) => void; onShowInLibrary: (path: string) => void;
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
  // (none for a card made from what Steam said alone: a preset's base, store showBrowseItem — no broken picture)
  const baseSrc = w.animatedThumbnailUrl && /^https?:/i.test(w.animatedThumbnailUrl) ? still(w.animatedThumbnailUrl, CARD_STILL_W) : w.thumbnailUrl ? thumb(w.thumbnailUrl) : "";
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
  // (the Steam app / page) keep Download and the card. Guard: probe-steam steam:subMerge:*
  const subIsDownload = useStore((s) => subscribeIsDownload(s.settings)) && isWorkshopItem(w);
  const GetIcon = subIsDownload ? CloudDownload : Download;
  // a download the mode can't do now (components/subscribeMode.ts actionBlocked: signed out under "Subscribe with Steam
  // login"): both buttons disabled up front, the line under them says why; their right-click menu still opens (its entries say
  // their own). Guard: probe-steam side:blocked:download
  const getOff = useStore((s) => isWorkshopItem(w) ? actionBlocked(s.settings, s.steam, "download") : null);
  // otherwise that line says what the buttons do in the chosen mode (components/subscribeMode.ts downloadHint): in three of
  // the four modes they subscribe, which the subscription card under them must not seem to contradict
  const getHint = useStore((s) => isWorkshopItem(w) ? downloadHint(s.settings) : null);
  const mode = useStore((s) => s.settings?.workshopDownloadMode);
  const motionOn = useMotion();
  // A Workshop item's download / subscribe buttons have a right-click menu (components/ContextMenu.tsx) with the button's own
  // one-off variant: Download's "Download without subscribing", "Download & Apply"'s "… & apply", a copy that stays no
  // subscription (menuItems.tsx oneOffMenuItem; "Download then unsubscribe" where that is how it's done). How it would be
  // fetched (GET /workshop/one-off) is asked as the pointer reaches a button, so the menu opens with its answer: without a
  // way, the entry is disabled and its note says what's missing. Guard: probe-steam side:oneOff:menu, side:oneOff:missing
  const oneOffable = isWorkshopItem(w);
  const [menu, setMenu] = useState<MenuAt | null>(null);
  // the button whose menu is open (kept through the menu's fade out)
  const [menuApply, setMenuApply] = useState(false);
  const [oneOff, setOneOff] = useState<OneOffRoute | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const menuFrom = useRef<HTMLButtonElement | null>(null);
  const asked = useRef<{ at: number; key: string; p: Promise<OneOffRoute> } | null>(null);
  // the route follows the download mode and the sign-in (a sign-out turns "Subscribe with Steam login"'s off): either changing
  // here asks again at once
  const routeKey = useStore((s) => `${String(s.settings?.workshopDownloadMode)}|${s.steam?.usable ?? (s.steam?.signedIn && !s.steam?.rejected)}`);
  const askOneOff = () => {
    if (asked.current && asked.current.key === routeKey && Date.now() - asked.current.at < ONE_OFF_FRESH_MS) return asked.current.p;
    const p = api.workshopOneOff().catch((): OneOffRoute => ({ route: null, missing: "Couldn't check how to download it here. Try again." }));
    asked.current = { at: Date.now(), key: routeKey, p };
    return p;
  };
  const getMenu = oneOffable ? {
    "aria-haspopup": "menu" as const,
    onPointerEnter: () => { void askOneOff(); },
    onContextMenu: (e: MouseEvent<HTMLButtonElement>) => {
      e.preventDefault();
      const at = menuAt(e), apply = e.currentTarget.dataset.sideGet === "apply";
      menuFrom.current = e.currentTarget;
      void askOneOff().then((r) => { setOneOff(r); setMenuApply(apply); setMenu(at); });
    },
  } : {};
  const missing = oneOff?.route ? null : oneOff?.missing ?? null;
  const rise = motionOn ? { initial: { opacity: 0, y: -4 }, animate: { opacity: 1, y: 0 }, exit: { opacity: 0, y: -4 },
    transition: { duration: 0.2, ease: [0.2, 0.9, 0.3, 1] as const } } : FADE;
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
          {/* Steam's current counts, the Library sidebar's own pills (components/sidePills.tsx). Guard: probe-steam ws:counts */}
          <StatPills subscriptions={w.subscriptions} favorites={w.favorites} />
          <SizePill bytes={w.fileSizeBytes} title="Size" />
          {/* the name is selectable text (index.css), the way to copy it */}
          {w.authorName && !w.workshopId && <span className="side-pill" title="Author" data-side-author><User size={13} /> <span className="side-author-name">{w.authorName}</span></span>}
          {w.workshopId && <WorkshopIdPill id={w.workshopId} />}
        </div>
        {/* who made it — a click lists all of their wallpapers in Browse */}
        {w.workshopId && <CreatorRow workshopId={w.workshopId} authorId={w.authorId} />}
        {/* a scene: the presets made for it (only while presets can play); a preset: the scene it uses */}
        {w.workshopId && w.isScene && !w.isPreset && <PresetsRow workshopId={w.workshopId} title={w.title} scene={w} />}
        {w.workshopId && w.isPreset && <BaseRow presetId={w.workshopId} onShowInLibrary={onShowInLibrary} />}
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
              <button className="btn accent ico side-go" data-side-get="apply" ref={magnetRef} aria-disabled={getOff ? true : undefined}
                onClick={getOff ? undefined : () => onDownload(true)} {...getMenu}><span className="side-dl-ico"><GetIcon size={16} /></span> {subIsDownload ? "Subscribe" : "Download"} &amp; Apply</button>
              <button className="btn ghost ico side-go" data-side-get="only" aria-disabled={getOff ? true : undefined}
                onClick={getOff ? undefined : () => onDownload(false)} {...getMenu}><span className="side-dl-ico"><GetIcon size={15} /></span> {subIsDownload ? "Subscribe" : "Download"}</button>
              {/* COOL: the reason rises in under the buttons (motion off: fades), a sign-in turning it off live included; it takes
                  the place of what the buttons do, both in one cell (index.css .side-cta-note), so a swap never stacks them */}
              <div className="side-cta-note">
                <AnimatePresence initial={false}>
                  {getOff ? <motion.span key={getOff} className="side-cta-why" data-side-get-why {...rise}>{getOff}</motion.span>
                    : getHint && <motion.span key={getHint} className="side-cta-why" data-side-get-hint {...rise}>{getHint}</motion.span>}
                </AnimatePresence>
              </div>
            </>
          )}
        </div>
        {/* outside the buttons' branch: a pick starts the download, and the menu still fades out once they're gone */}
        {oneOffable && <ContextMenu at={menu} onClose={closeMenu} returnTo={menuFrom} label="Download" note={missing}
          items={[oneOffMenuItem(menuApply, mode, () => onDownload(menuApply, true), missing)]} />}
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
