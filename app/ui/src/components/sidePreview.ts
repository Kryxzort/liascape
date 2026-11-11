import { useState, type CSSProperties } from "react";
import { useStore, type PreviewKind } from "../store";

// The item sidebar's non-component helpers (components/SidePanel.tsx is the shell + the picture).

// a range input's accent fill (index.css `.side-panel input[type=range]` paints the track up to --fill)
export const rangeFill = (v: number, min: number, max: number): CSSProperties =>
  ({ "--fill": `${Math.max(0, Math.min(100, ((v - min) / (max - min || 1)) * 100))}%` } as CSSProperties);

// ---- the picture's preview switch (owner 2026-11-11: "a button to switch between gif preview, mp4 preview and youtube video
// preview"). The options are what the item has: its base — the gif / webp, else the still ("Picture") — a video (the library
// item's own file; Browse: a remote preview video) and its YouTube trailer. The default is the base: a video never plays
// unasked (owner 2026-11-11: "dont force mp4 when the preview is a still image"); a pick is kept for the
// session per sidebar (`previewPref`): the next item opens on it when it has it, else on the default.
export type PreviewAvail = { gif: boolean; video: boolean; youtube: boolean };
export function usePreview(side: "library" | "browse", a: PreviewAvail) {
  const pref = useStore((s) => s.previewPref[side]);
  const setPref = useStore((s) => s.setPreviewPref);
  const [picked, setPicked] = useState<PreviewKind | null>(null); // this item's own pick (it outlives a later pref)
  // the base is what the card shows: its gif, else the still — never the video (owner 2026-11-11: "dont force mp4 when the
  // preview is a still image"); the video / trailer are there to pick
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

