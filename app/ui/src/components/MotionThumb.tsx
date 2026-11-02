import { media, still, anim as animUrl, CARD_STILL_W, type LibraryItem } from "../api/client";

const VIDEO_RE = /\.(mp4|webm|mov|mkv|avi)$/i;

// True when this item has a cheap animated asset (gif/webp) — eligible for AutoPlayGifs bulk play.
// A video-only item animates on hover (heavier), never in bulk.
export function hasGifAsset(item: LibraryItem): boolean {
  return !!item.animatedThumbnailPath && !VIDEO_RE.test(item.animatedThumbnailPath);
}

// Whether a mouse event happened over `el`. A context menu's backdrop covers the window, so at its close the browser's hover
// state is stale (the card's mouseleave came when the menu opened; a bar item, the menu's React parent, never got one).
export function pointerOver(el: HTMLElement, e: React.MouseEvent): boolean {
  const r = el.getBoundingClientRect();
  return e.clientX >= r.left && e.clientX < r.right && e.clientY >= r.top && e.clientY < r.bottom;
}

// True when the item's only preview is a VIDEO (no gif/webp asset; a scene has none) — what "Autoplay video thumbnails"
// plays without a hover (components/autoplay.ts).
export function hasVideoPreview(item: LibraryItem): boolean {
  if (item.isScene) return false;
  return item.animatedThumbnailPath ? VIDEO_RE.test(item.animatedThumbnailPath) : VIDEO_RE.test(item.videoPath);
}

// COOL: animated library/playlist preview. Reuses the source's preview gif/webp when present;
// otherwise plays the local wallpaper video on hover (moewalls-type sources ship no gif).
// Browsers autoplay gif/webp <img> and decode off-thread → no special gif decode machinery is
// needed. PERF: the parent card has content-visibility:auto, so offscreen cards never mount the
// animated layer at all. `active` = should-animate (hover, or AutoPlayGifs for gif assets); `autoVideo` = this item holds an
// autoplay slot (useAutoplayVideo): its video layer plays like a hover, a gif is not touched.
export function MotionThumb({ item, active, autoVideo = false }: { item: LibraryItem; active: boolean; autoVideo?: boolean }) {
  const anim = item.animatedThumbnailPath;
  const animIsVideo = !!anim && VIDEO_RE.test(anim);
  const videoFallback = !anim && !item.isScene && VIDEO_RE.test(item.videoPath);
  // When the only sibling image is the preview
  // gif/webp, thumbnailPath IS that gif — still() extracts a frozen frame so the STATIC layer doesn't
  // animate regardless of AutoPlayGifs. Plain jpg/png pass straight through to /media. When there's no
  // static thumbnail at all (gif-only items / dangling we_thumbs links), extract the still from the gif.
  const stillSrc = item.thumbnailPath || item.animatedThumbnailPath;
  const staticSrc = stillSrc ? still(stillSrc, CARD_STILL_W) : "";
  return (
    <>
      <img className="thumb" src={staticSrc} loading="lazy" decoding="async" alt="" />
      {active && anim && !animIsVideo && (
        // gif → /anim (leading-black trimmed); backgroundImage = the /still frame so the loop-gap
        // shows a real frame, not black (parity with the Browse Card).
        <img className="thumb anim" src={animUrl(anim)} decoding="async" alt=""
          style={{ backgroundImage: `url("${staticSrc}")`, backgroundSize: "cover", backgroundPosition: "center" }} />
      )}
      {(active || autoVideo) && anim && animIsVideo && (
        <video className="thumb anim" src={media(anim)} muted loop autoPlay playsInline preload="metadata" />
      )}
      {(active || autoVideo) && videoFallback && (
        <video className="thumb anim" src={media(item.videoPath)} muted loop autoPlay playsInline preload="none" />
      )}
    </>
  );
}
