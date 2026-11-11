import type { LibraryItem } from "../api/client";

export const VIDEO_RE = /\.(mp4|webm|mov|mkv|avi)$/i;
// True when this item has a cheap animated asset (gif/webp) — eligible for AutoPlayGifs bulk play.
// A video-only item animates on hover (heavier), never in bulk.
export function hasGifAsset(item: LibraryItem): boolean {
  return !!item.animatedThumbnailPath && !VIDEO_RE.test(item.animatedThumbnailPath);
}

// True when the item's only preview is a VIDEO (no gif/webp asset; a scene has none) — what "Autoplay video thumbnails"
// plays without a hover (components/autoplay.ts).
export function hasVideoPreview(item: LibraryItem): boolean {
  if (item.isScene) return false;
  return item.animatedThumbnailPath ? VIDEO_RE.test(item.animatedThumbnailPath) : VIDEO_RE.test(item.videoPath);
}
