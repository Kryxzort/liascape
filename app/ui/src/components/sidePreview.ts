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


// ---- the sidebar previews' own sound level (SidePanel.tsx PreviewVolume, YouTubeEmbed.tsx): one 0–100 level for the video
// preview and the YouTube trailer, remembered across items and restarts. A UI-only preference (localStorage, like the
// trailer's mute) — never the wallpaper's own volume, the global one or anything the backend plays. `last` is the last
// audible level: unmuting a preview dragged down to 0 brings it back. No saved level yet → the trailer's older saved level
// (`liascape_yt_volume`), else half: a preview shouldn't blast the first time it's unmuted.
const PV_KEY = "liascape.previewVolume", PV_LAST_KEY = "liascape.previewVolumeLast", PV_DEFAULT = 50;
type PreviewVol = { level: number; last: number };
const readNum = (k: string): number | null => {
  try { const s = localStorage.getItem(k); const n = s == null ? NaN : Number(JSON.parse(s)); return Number.isFinite(n) ? Math.round(Math.max(0, Math.min(100, n))) : null; }
  catch { return null; }
};
let pv: PreviewVol = (() => {
  const level = readNum(PV_KEY) ?? readNum("liascape_yt_volume") ?? PV_DEFAULT;
  const last = readNum(PV_LAST_KEY) || level || PV_DEFAULT;
  return { level, last };
})();
const pvSubs = new Set<() => void>();
export const previewVolume = () => pv;
export function setPreviewVolume(v: number) {
  const level = Math.round(Math.max(0, Math.min(100, Number.isFinite(v) ? v : 0)));
  const last = level > 0 ? level : pv.last;
  if (level === pv.level && last === pv.last) return;
  pv = { level, last };
  try { localStorage.setItem(PV_KEY, JSON.stringify(level)); localStorage.setItem(PV_LAST_KEY, JSON.stringify(last)); } catch { /* ignore */ }
  for (const f of pvSubs) f();
}
const subscribePv = (cb: () => void) => { pvSubs.add(cb); return () => { pvSubs.delete(cb); }; };
export const usePreviewVolume = () => useSyncExternalStore(subscribePv, previewVolume);
