import { useState } from "react";
import { NumInput } from "./NumInput";

// A rotation duration in seconds as h / m / s fields — "Switch every", "Minimum play time", "Maximum play time"
// (Settings → Rotation and the playlist modal). A thin wrapper over the shared `NumInput` (docs/decisions.md § "Let
// numeric fields be emptied while focused": free typing while focused — empty, partial, out of range — a complete in-range number commits live, blur /
// Enter clamps and saves), one per unit; the total is clamped to `max` (99:59:59, the backend's own clamp).
export const MAX_PLAY_SECONDS = 359999;

export function PlayTimeInput({ value, onChange, disabled, label, zeroText, min = 0, max = MAX_PLAY_SECONDS }: {
  value: number; onChange: (v: number) => void; disabled?: boolean;
  /** the group's accessible name; each field gets "<label> hours|minutes|seconds" */
  label: string;
  /** shown next to the fields while the total is 0 (e.g. "off") */
  zeroText?: string;
  /** the smallest total (e.g. 1 where 0 would mean "never") */
  min?: number;
  max?: number;
}) {
  const v = Math.max(0, value | 0);
  // a total under `min` (minutes zeroed before the seconds go in) is a DRAFT: shown, never saved. Clamped to `min` it
  // would save 1 s and switch the wallpaper at once; dropped, the next field would rebuild from the saved value (0 m +
  // 4 s → 30:04). The draft belongs to the value it was typed over (a new value drops it), and leaving the group drops it.
  // Guard: probe-matrix playlist:sceneTiming / global:sceneTiming (h + m zeroed first)
  const [draft, setDraft] = useState<{ t: number; over: number } | null>(null);
  const shown = draft && draft.over === v ? draft.t : v;
  const H = Math.floor(shown / 3600), M = Math.floor((shown % 3600) / 60), S = shown % 60;
  const set = (h: number, m: number, s: number) => {
    const t = Math.min(max, h * 3600 + m * 60 + s);
    if (t >= min) { setDraft(null); onChange(t); } else setDraft({ t, over: v });
  };
  return (
    <div className="hms" role="group" aria-label={label}
      onBlur={(e) => { if (draft && !e.currentTarget.contains(e.relatedTarget as Node | null)) setDraft(null); }}>
      <NumInput min={0} max={99} disabled={disabled} value={H} aria-label={`${label} hours`} onChange={(n) => set(n, M, S)} /><span>h</span>
      <NumInput min={0} max={59} disabled={disabled} value={M} aria-label={`${label} minutes`} onChange={(n) => set(H, n, S)} /><span>m</span>
      <NumInput min={0} max={59} disabled={disabled} value={S} aria-label={`${label} seconds`} onChange={(n) => set(H, M, n)} /><span>s</span>
      {zeroText && v === 0 && <span className="playtime-zero">{zeroText}</span>}
    </div>
  );
}
