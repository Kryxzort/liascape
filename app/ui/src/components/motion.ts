import { useSyncExternalStore } from "react";
import { useStore } from "../store";

// Motion switches + reading a card's picture state (was morph.ts / useMorph.ts: the card → modal flight went with the
// modals when the item sidebar replaced them, 2026-11-10 — the WAAPI flight code is in git history, last in c87376bb).

// the OS / desktop's "reduce motion" (prefers-reduced-motion): every motion the "Smooth window animations" toggle governs
// (the sidebar's slide / cross-fade, the tab slide, the playlist bar's dock lift) behaves as if that toggle were off
export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
export const reducedMotion = () => typeof matchMedia === "function" && matchMedia(REDUCED_MOTION_QUERY).matches;
// the toggle AND the OS preference — read outside React; components use useMotion()
export const motionOn = (settings: { morphs?: unknown } | null | undefined) => settings?.morphs !== false && !reducedMotion();

// Settings → "Smooth window animations" (`morphs`) and the OS's prefers-reduced-motion, live (a change to either re-renders)
const subscribeReduced = (cb: () => void) => { if (typeof matchMedia !== "function") return () => {}; const q = matchMedia(REDUCED_MOTION_QUERY); q.addEventListener("change", cb); return () => q.removeEventListener("change", cb); };
export function useMotion(): boolean {
  const morphs = useStore((s) => s.settings?.morphs !== false);
  const reduced = useSyncExternalStore(subscribeReduced, reducedMotion);
  return morphs && !reduced;
}

// A card (library `.thumb-wrap` = `lib-<path>`, playlist bar `.pl-item` = `pl-<path>`, Browse card = `br-<page URL>`) carries
// `data-morph-id`; the sidebar reads, when an item gets focused, what that card has loaded: the picture's aspect (its box
// is sized right from the first frame — no jump when the image loads) and where its hover video was (the sidebar's video
// starts there).
export type MorphSource = { aspect: number | null; videoTime: number | null };
export function sourceEl(morphId: string | null): HTMLElement | null {
  if (!morphId) return null;
  return document.querySelector<HTMLElement>(`[data-morph-id="${CSS.escape(morphId)}"]`);
}
export function captureSource(morphId: string | null): MorphSource {
  const el = sourceEl(morphId);
  const vid = el?.querySelector<HTMLVideoElement>("video.thumb.anim");
  let aspect: number | null = null;
  for (const i of el?.querySelectorAll<HTMLImageElement>("img.thumb:not(.anim), img.thumb.anim") ?? [])
    if (i.naturalWidth && i.naturalHeight) { aspect = i.naturalWidth / i.naturalHeight; break; }
  if (aspect == null && vid?.videoWidth && vid.videoHeight) aspect = vid.videoWidth / vid.videoHeight;
  return { aspect, videoTime: vid && !vid.paused ? vid.currentTime : null };
}
