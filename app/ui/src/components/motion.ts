import { useSyncExternalStore } from "react";
import { useStore } from "../store";

// Motion switches + reading a card's picture state (docs/decisions.md § "Replace the card settings and preview modals with
// an item sidebar": no card → modal flight).

// the OS / desktop's "reduce motion" (prefers-reduced-motion): every motion the "Smooth window animations" toggle governs
// (the sidebar's slide / cross-fade, the tab slide, the playlist bar's dock lift) behaves as if that toggle were off
// Motion off = nothing moves, short fades (docs/decisions.md § "Fade, never move, with motion off"): an appear, a leave or a
// content swap cross-fades in FADE_MS on opacity alone (index.css `--fade-dur`, the same length); a slide, zoom, morph,
// tilt, spring or glide becomes that fade, or nothing (hover holds, pointer feedback). Guard: the motion-off probe cells
// ("only opacity changes, nothing moves", e.g. probe-sidebar lib:slide, probe-filters motion:match)
export const FADE_MS = 120;
// how long a fading exit stays mounted: its fade starts a frame or two after the render that ends it, so a bare FADE_MS
// cuts it off part-way (a pop at the end). Guard: probe-filters motion:match (the closed one lingers)
export const FADE_EXIT_MS = FADE_MS + 50;
// framer props for an appear / leave / swap with motion off: opacity only (a transform target, even an instant one, would
// jump: framer's own reduced motion still sets it)
export const FADE = {
  initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 },
  transition: { duration: FADE_MS / 1000, ease: "linear" as const },
};
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
// for a framer appear / leave that moves (a modal's zoom, a toast's rise): `fadeOff(props)` = those props with motion, FADE
// without
export function useFadeOff() {
  const on = useMotion();
  return <T extends object>(props: T): T | typeof FADE => (on ? props : FADE);
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
