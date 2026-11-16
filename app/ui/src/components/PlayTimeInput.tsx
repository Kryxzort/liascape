import { useState } from "react";
import { NumInput } from "./NumInput";

// A rotation duration in seconds as h / m / s fields — "Switch every", "Minimum play time", "Maximum play time"
// (Settings → Rotation and the playlist modal). A thin wrapper over the shared `NumInput` (docs/decisions.md § "Let
// numeric fields be emptied while focused": free typing while focused — empty, partial, out of range — a complete in-range number commits live, blur /
// Enter clamps and saves), one per unit; the total is clamped to `max` (99:59:59, the backend's own clamp).
export const MAX_PLAY_SECONDS = 359999;

export function PlayTimeInput({ value, onChange, disabled, label, zeroText, min = 0, orZero, max = MAX_PLAY_SECONDS }: {
  value: number; onChange: (v: number) => void; disabled?: boolean;
  /** the group's accessible name; each field gets "<label> hours|minutes|seconds" */
  label: string;
  /** shown next to the fields while the total is 0 (e.g. "off") */
  zeroText?: string;
  /** the smallest total (e.g. 1 where 0 would mean "never") */
  min?: number;
  /** 0 is allowed too ("off"): the total is 0 or at least `min` (the maximum over the minimum) */
  orZero?: boolean;
  max?: number;
}) {
  const v = Math.max(0, value | 0);
  // a total under `min` (minutes zeroed before the seconds go in) is a DRAFT: shown, never saved. Clamped to `min` it
  // would save 1 s and switch the wallpaper at once; dropped, the next field would rebuild from the saved value (0 m +
  // 4 s → 30:04). The draft belongs to the value it was typed over (a new value drops it). Leaving the group drops it,
  // except under `orZero`: there it saves `min`, the nearest total allowed (a maximum typed under the minimum becomes
  // the minimum, as a numeric field clamps on blur; nothing switches sooner than the minimum would).
  // Guard: probe-matrix playlist:sceneTiming / global:sceneTiming (h + m zeroed first); probe-settings playtime:*
  const [draft, setDraft] = useState<{ t: number; over: number } | null>(null);
  const shown = draft && draft.over === v ? draft.t : v;
  const H = Math.floor(shown / 3600), M = Math.floor((shown % 3600) / 60), S = shown % 60;
  const total = (h: number, m: number, s: number) => Math.min(max, h * 3600 + m * 60 + s);
  const allowed = (t: number) => t >= min || (orZero && t === 0);
  const set = (h: number, m: number, s: number) => {
    const t = total(h, m, s);
    if (allowed(t)) { setDraft(null); onChange(t); } else setDraft({ t, over: v });
  };
  // a step (−/+, keys, wheel) is never a draft: nobody is typing a number that needs a moment to be complete, and a draft
  // made by a click with the focus elsewhere would stay on screen unsaved. One that lands under `min` (or in the gap between
  // 0 and `min`) stops at `min`, so what the fields show is what is saved. Answers the field's own unit of the total saved.
  // Guard: probe-settings playtime:maxFloor:* (steps)
  const step = (unit: 0 | 1 | 2, h: number, m: number, s: number) => {
    const t = total(h, m, s), r = allowed(t) ? t : min;
    setDraft(null);
    if (r !== v) onChange(r);
    return unit === 0 ? Math.floor(r / 3600) : unit === 1 ? Math.floor((r % 3600) / 60) : r % 60;
  };
  return (
    <div className="hms" role="group" aria-label={label}
      onBlur={(e) => {
        if (!draft || e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setDraft(null);
        if (orZero && draft.over === v && min !== v) onChange(min);
      }}>
      <NumInput min={0} max={99} disabled={disabled} value={H} aria-label={`${label} hours`} onChange={(n) => set(n, M, S)} onStep={(n) => step(0, n, M, S)} /><span>h</span>
      <NumInput min={0} max={59} disabled={disabled} value={M} aria-label={`${label} minutes`} onChange={(n) => set(H, n, S)} onStep={(n) => step(1, H, n, S)} /><span>m</span>
      <NumInput min={0} max={59} disabled={disabled} value={S} aria-label={`${label} seconds`} onChange={(n) => set(H, M, n)} onStep={(n) => step(2, H, M, n)} /><span>s</span>
      {zeroText && shown === 0 && <span className="playtime-zero">{zeroText}</span>}
    </div>
  );
}
