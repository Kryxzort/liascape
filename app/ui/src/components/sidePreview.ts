import { useState, type CSSProperties } from "react";
import { useStore, type PreviewKind } from "../store";

// The item sidebar's non-component helpers (components/SidePanel.tsx is the shell + the picture).

// a range input's accent fill (index.css `.side-panel input[type=range]` paints the track up to --fill)
export const rangeFill = (v: number, min: number, max: number): CSSProperties =>
  ({ "--fill": `${Math.max(0, Math.min(100, ((v - min) / (max - min || 1)) * 100))}%` } as CSSProperties);

// ---- the picture's preview switch (owner 2026-11-11: "a button to switch between gif preview, mp4 preview and youtube video
// preview"). The options are what the item has: its gif / webp, a video (the library item's own file; Browse: a remote
// preview video), its YouTube trailer — and, when the trailer is all it has, the still ("Picture"), so the trailer can be
// turned off again. The default is what the picture always showed (gif, else video, else the still); a pick is kept for the
// session per sidebar (`previewPref`): the next item opens on it when it has it, else on the default.
export type PreviewAvail = { gif: boolean; video: boolean; youtube: boolean };
export function usePreview(side: "library" | "browse", a: PreviewAvail) {
  const pref = useStore((s) => s.previewPref[side]);
  const setPref = useStore((s) => s.setPreviewPref);
  const [picked, setPicked] = useState<PreviewKind | null>(null); // this item's own pick (it outlives a later pref)
  const options: PreviewKind[] = [];
  if (a.gif) options.push("gif");
  if (a.video) options.push("video");
  if (a.youtube) { if (!a.gif && !a.video) options.push("image"); options.push("youtube"); }
  const def: PreviewKind = a.gif ? "gif" : a.video ? "video" : "image";
  const ok = (k: PreviewKind | null): k is PreviewKind => k != null && (k === def || options.includes(k));
  // derived, not an effect: a Browse item's trailer / video arrives with its detail — a kept "YouTube" switches to it then
  const mode: PreviewKind = ok(picked) ? picked : ok(pref) ? pref : def;
  const pick = (k: PreviewKind) => { setPicked(k); setPref(side, k); };
  return { mode, options: options.length > 1 ? options : [], def, pick };
}

