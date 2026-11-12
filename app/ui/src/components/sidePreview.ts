import { useState, useSyncExternalStore, type CSSProperties } from "react";
import { useStore, type PreviewKind } from "../store";

// The item sidebar's non-component helpers (components/SidePanel.tsx is the shell + the picture).

// a range input's accent fill (index.css `.side-panel input[type=range]` paints the track up to --fill)
export const rangeFill = (v: number, min: number, max: number): CSSProperties =>
  ({ "--fill": `${Math.max(0, Math.min(100, ((v - min) / (max - min || 1)) * 100))}%` } as CSSProperties);

// ---- the picture's preview switch (docs/decisions.md § "Open previews on the gif or still, never the video, and remember
// the pick per sidebar"). The options are what the item has: its base — the gif / webp, else the still ("Picture") — a video (the library
// item's own file; Browse: a remote preview video) and its YouTube trailer. The default is the base: a video never plays
// unasked; a pick is kept for the
// session per sidebar (`previewPref`): the next item opens on it when it has it, else on the default.
// online? — the YouTube trailer is the one preview that needs the network: offline the switch doesn't offer it (it would
// open a dead player); the gif / video / picture are local files. Follows the browser's online / offline events.
const subscribeOnline = (cb: () => void) => { window.addEventListener("online", cb); window.addEventListener("offline", cb);
  return () => { window.removeEventListener("online", cb); window.removeEventListener("offline", cb); }; };
export const useOnline = () => useSyncExternalStore(subscribeOnline, () => navigator.onLine);

export type PreviewAvail = { gif: boolean; video: boolean; youtube: boolean };
export function usePreview(side: "library" | "browse", a: PreviewAvail) {
  const pref = useStore((s) => s.previewPref[side]);
  const setPref = useStore((s) => s.setPreviewPref);
  const [picked, setPicked] = useState<PreviewKind | null>(null); // this item's own pick (it outlives a later pref)
  // the base is what the card shows: its gif, else the still — never the video; the video / trailer are there to pick
  const def: PreviewKind = a.gif ? "gif" : "image";
  const options: PreviewKind[] = [def];
  if (a.video) options.push("video");
  if (a.youtube) options.push("youtube");
  const ok = (k: PreviewKind | null): k is PreviewKind => k != null && (k === def || options.includes(k));
  // derived, not an effect: a Browse item's trailer / video arrives with its detail — a kept "YouTube" switches to it then
  const mode: PreviewKind = ok(picked) ? picked : ok(pref) ? pref : def;
  const pick = (k: PreviewKind) => { setPicked(k); setPref(side, k); };
  return { mode, options: options.length > 1 ? options : [], def, pick };
}


// ---- the sidebar previews' sound (SidePanel.tsx PreviewVolume, YouTubeEmbed.tsx): one mute and one 0–100 level for the
// video preview and the YouTube trailer, remembered across items and restarts. UI-only preferences (localStorage) — they
// never change the wallpaper's own volume, the global one or anything the backend plays.
// - mute: the first preview ever opens muted (the desktop's wallpaper owns the sound); after that, whatever the user left
//   it at.
// - level: until the user moves the preview's own slider (or the trailer's), `own` is null and the preview plays at the
//   item's effective wallpaper volume (`override ?? global`, the caller's `wall`), following it live; once moved, `own`
//   is kept for every item. `last` is the last audible own level: unmuting a preview dragged down to 0 brings it back.
// Guard: probe-sidebar preview:volume, preview:follow
const PV_KEY = "liascape.previewVolume", PV_LAST_KEY = "liascape.previewVolumeLast", PV_MUTED_KEY = "liascape.previewMuted";
// unmuting at 0 with no audible level to return to (an untouched preview of a wallpaper at 0): audible, but not loud
const UNMUTE_FALLBACK = 50;
type PreviewSound = { own: number | null; last: number | null; muted: boolean };
const clampLevel = (n: number) => Math.round(Math.max(0, Math.min(100, Number.isFinite(n) ? n : 0)));
const readNum = (k: string): number | null => {
  try { const s = localStorage.getItem(k); const n = s == null ? NaN : Number(JSON.parse(s)); return Number.isFinite(n) ? clampLevel(n) : null; }
  catch { return null; }
};
const readMuted = (): boolean => {
  try { const s = localStorage.getItem(PV_MUTED_KEY); return s == null ? true : s !== "0" && s !== "false"; }
  catch { return true; }
};
let ps: PreviewSound = { own: readNum(PV_KEY), last: readNum(PV_LAST_KEY) || null, muted: readMuted() };
const psSubs = new Set<() => void>();
const save = (k: string, v: number | boolean) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } };
const emit = (next: PreviewSound) => { ps = next; for (const f of psSubs) f(); };
export const previewSound = () => ps;
// the level a preview of a wallpaper at `wall` plays at (before mute)
export const previewLevel = (s: PreviewSound, wall: number) => s.own ?? clampLevel(wall);
// the preview's own level, set by the user: from now on it no longer follows the wallpaper's volume
export function setPreviewVolume(v: number) {
  const own = clampLevel(v), last = own > 0 ? own : ps.last;
  if (own === ps.own && last === ps.last) return;
  save(PV_KEY, own); if (last != null) save(PV_LAST_KEY, last);
  emit({ ...ps, own, last });
}
export function setPreviewMuted(muted: boolean) {
  if (muted === ps.muted) return;
  save(PV_MUTED_KEY, muted ? 1 : 0);
  emit({ ...ps, muted });
}
// unmute; at a level of 0 also bring back the last audible level (else the unmute would stay silent)
export function unmutePreview(wall: number) {
  if (previewLevel(ps, wall) === 0) setPreviewVolume(ps.last ?? UNMUTE_FALLBACK);
  setPreviewMuted(false);
}
const subscribePs = (cb: () => void) => { psSubs.add(cb); return () => { psSubs.delete(cb); }; };
export const usePreviewSound = () => useSyncExternalStore(subscribePs, previewSound);
