import { NumInput } from "./NumInput";

// A rotation duration in seconds as h / m / s fields — "Switch every", "Minimum play time", "Maximum play time"
// (Settings → Rotation and the playlist modal). A thin wrapper over the shared `NumInput` (docs/decisions.md § "Let
// numeric fields be emptied while focused": free typing while focused — empty, partial, out of range — a complete in-range number commits live, blur /
// Enter clamps and saves), one per unit; the total is clamped to `max` (99:59:59, the backend's own clamp).
export const MAX_PLAY_SECONDS = 359999;

export function PlayTimeInput({ value, onChange, disabled, label, zeroText, max = MAX_PLAY_SECONDS }: {
  value: number; onChange: (v: number) => void; disabled?: boolean;
  /** the group's accessible name; each field gets "<label> hours|minutes|seconds" */
  label: string;
  /** shown next to the fields while the total is 0 (e.g. "off") */
  zeroText?: string;
  max?: number;
}) {
  const v = Math.max(0, value | 0);
  const H = Math.floor(v / 3600), M = Math.floor((v % 3600) / 60), S = v % 60;
  const set = (h: number, m: number, s: number) => onChange(Math.min(max, h * 3600 + m * 60 + s));
  return (
    <div className="hms" role="group" aria-label={label}>
      <NumInput min={0} max={99} disabled={disabled} value={H} aria-label={`${label} hours`} onChange={(n) => set(n, M, S)} /><span>h</span>
      <NumInput min={0} max={59} disabled={disabled} value={M} aria-label={`${label} minutes`} onChange={(n) => set(H, n, S)} /><span>m</span>
      <NumInput min={0} max={59} disabled={disabled} value={S} aria-label={`${label} seconds`} onChange={(n) => set(H, M, n)} /><span>s</span>
      {zeroText && v === 0 && <span className="playtime-zero">{zeroText}</span>}
    </div>
  );
}
