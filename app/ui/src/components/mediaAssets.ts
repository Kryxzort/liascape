import type { LibraryItem } from "../api/client";
import { useStore } from "../store";

export const VIDEO_RE = /\.(mp4|webm|mov|mkv|avi)$/i;
// True when this item has a cheap animated asset (gif/webp) — eligible for AutoPlayGifs bulk play.
export function hasGifAsset(item: LibraryItem): boolean {
  return !!item.animatedThumbnailPath && !VIDEO_RE.test(item.animatedThumbnailPath);
}

// The video an item's preview plays (on hover, or under "Animate wallpapers without a GIF"), or null: a video preview asset; else
// the wallpaper's own video when there is no gif/webp, or when `overGif` ("Use the video instead of the GIF") lets the video win
// over the gif. Guard: matrix appear:videoOverGif (every combination with the gif and video-preview toggles).
export function previewVideo(item: LibraryItem, overGif: boolean): string | null {
  const a = item.animatedThumbnailPath;
  if (a && VIDEO_RE.test(a)) return a;
  if (item.isScene || !VIDEO_RE.test(item.videoPath)) return null;
  return !a || overGif ? item.videoPath : null;
}

// True when the item's preview is a video (a scene has none) — what "Animate wallpapers without a GIF" plays without a hover
// (components/autoplay.ts).
export function hasVideoPreview(item: LibraryItem, overGif: boolean): boolean {
  return !item.isScene && previewVideo(item, overGif) !== null;
}

// Settings → "Use the video instead of the GIF": an item with both a gif/webp and its own video previews with the video.
export const useVideoOverGif = () => useStore((s) => !!s.settings?.preferVideoThumbs);
