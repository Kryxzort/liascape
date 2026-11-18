import type { LibraryItem } from "../api/client";
import { useStore } from "../store";

export const VIDEO_RE = /\.(mp4|webm|mov|mkv|avi)$/i;
// True when this item has a cheap animated asset (gif/webp): what a preview order's "gif" plays.
export function hasGifAsset(item: LibraryItem): boolean {
  return !!item.animatedThumbnailPath && !VIDEO_RE.test(item.animatedThumbnailPath);
}

// The video an item's preview plays, or null: a video preview asset, else the wallpaper's own video (a scene has none).
export function previewVideo(item: LibraryItem): string | null {
  const a = item.animatedThumbnailPath;
  if (a && VIDEO_RE.test(a)) return a;
  if (item.isScene || !VIDEO_RE.test(item.videoPath)) return null;
  return item.videoPath;
}

// Settings → "On hover" / "Not hovered" (`previewOnHover` / `previewNotHovered`): each the user's order of the three
// things a card can show. A card shows the first one it has; every card has its still image, so whatever follows "image"
// is never reached ("image" first = nothing plays). The backend keeps each list to the three kinds once each
// (Models/AppSettings.cs PreviewOrder). Guard: matrix appear:previewOrder, probe-cardpreview cardpv:order.
export type ThumbKind = "video" | "gif" | "image";
export const THUMB_KINDS: ThumbKind[] = ["video", "gif", "image"];
export const DEFAULT_ON_HOVER: ThumbKind[] = ["gif", "video", "image"];
export const DEFAULT_NOT_HOVERED: ThumbKind[] = ["image", "gif", "video"];

// a saved list as a full order: known kinds once each, the missing ones after in the default's order
export function previewOrder(v: unknown, def: ThumbKind[]): ThumbKind[] {
  const got = Array.isArray(v) ? v.filter((k, i): k is ThumbKind => (THUMB_KINDS as unknown[]).includes(k) && v.indexOf(k) === i) : [];
  return [...got, ...def.filter((k) => !got.includes(k))];
}
// what an order reaches: up to and including "image" (two orders with the same reach behave the same)
export const reach = (order: ThumbKind[]): ThumbKind[] => order.slice(0, order.indexOf("image") + 1);

export function firstPreview(order: ThumbKind[], has: { video: boolean; gif: boolean }): ThumbKind {
  for (const k of order) if (k === "image" || has[k]) return k;
  return "image";
}

// PERF: a card reads each order as a string (a stable selector value), parsed once per distinct order
const parsed = new Map<string, ThumbKind[]>();
const asOrder = (k: string) => { let o = parsed.get(k); if (!o) parsed.set(k, (o = k.split(",") as ThumbKind[])); return o; };
const keyOf = (v: unknown, def: ThumbKind[]) => previewOrder(v, def).join(",");
export const useHoverOrder = () => asOrder(useStore((s) => keyOf(s.settings?.previewOnHover, DEFAULT_ON_HOVER)));
// nothing plays by itself while the window is inactive (App.tsx appActive): no decode drain behind other windows
export const useIdleOrder = () => asOrder(useStore((s) => (s.appActive ? keyOf(s.settings?.previewNotHovered, DEFAULT_NOT_HOVERED) : "image")));

// "Not hovered" as it reads with the window active, whatever it is now: a gif preview played as a video stays on its paused
// frame while the window is inactive (components/MotionThumb.tsx), so it needs the order the inactive window hides
export const useIdleOrderActive = () => asOrder(useStore((s) => keyOf(s.settings?.previewNotHovered, DEFAULT_NOT_HOVERED)));

// Settings → "Play GIF previews as videos" (`gifPreviewsAsVideo`): the local .gif this item's gif preview plays as a clip
// made from it (the backend's Web/ClipStore.cs, the same clips as a video preview's), or null: the setting is off, the item
// has no gif, or its animation is a remote url or an animated webp (they play as they are).
export const useGifVideo = (item: LibraryItem): string | null => {
  const on = useStore((s) => s.settings?.gifPreviewsAsVideo === true);
  const a = item.animatedThumbnailPath;
  return on && a && /\.gif$/i.test(a) && !/^https?:/i.test(a) ? a : null;
};

// What a library card / playlist-bar item shows hovered and not. Not hovered, a scene never plays a video (its clip isn't
// made); hovered, a scene's video preview asset plays.
export function usePreviewKinds(item: LibraryItem | undefined): { hoverKind: ThumbKind; idleKind: ThumbKind } {
  const hoverOrder = useHoverOrder(), idleOrder = useIdleOrder();
  if (!item) return { hoverKind: "image", idleKind: "image" };
  const video = previewVideo(item) !== null, gif = hasGifAsset(item);
  return { hoverKind: firstPreview(hoverOrder, { video, gif }), idleKind: firstPreview(idleOrder, { video: video && !item.isScene, gif }) };
}

// Basic's "Card previews": a few named pairs of orders. A pair matches a preset when both lists reach the same kinds in the
// same order (what follows "image" never shows); otherwise it reads "Custom".
export type PreviewPreset = { value: string; label: string; hint: string; hover: ThumbKind[]; idle: ThumbKind[] };
export const PREVIEW_PRESETS: PreviewPreset[] = [
  { value: "still", label: "Never animate", hint: "every card shows its still image, hovered or not.",
    hover: ["image", "gif", "video"], idle: ["image", "gif", "video"] },
  { value: "hover", label: "Animate on hover", hint: "the card under the pointer plays its GIF, else its video.",
    hover: DEFAULT_ON_HOVER, idle: DEFAULT_NOT_HOVERED },
  { value: "hoverVideo", label: "Animate on hover, video first", hint: "the card under the pointer plays its video, else its GIF.",
    hover: ["video", "gif", "image"], idle: DEFAULT_NOT_HOVERED },
  { value: "always", label: "Always animate", hint: "every card on screen plays its GIF, else its video. Video previews use more processing and storage.",
    hover: ["gif", "video", "image"], idle: ["gif", "video", "image"] },
  { value: "video", label: "Always animate, video first", hint: "every card on screen plays its video, else its GIF. Video previews use more processing and storage.",
    hover: ["video", "gif", "image"], idle: ["video", "gif", "image"] },
];
const same = (a: ThumbKind[], b: ThumbKind[]) => reach(a).join() === reach(b).join();
export function presetOf(settings: Record<string, unknown> | null | undefined): PreviewPreset | null {
  const hover = previewOrder(settings?.previewOnHover, DEFAULT_ON_HOVER), idle = previewOrder(settings?.previewNotHovered, DEFAULT_NOT_HOVERED);
  return PREVIEW_PRESETS.find((p) => same(p.hover, hover) && same(p.idle, idle)) ?? null;
}
export const PREVIEW_KEYS = ["previewOnHover", "previewNotHovered"];
