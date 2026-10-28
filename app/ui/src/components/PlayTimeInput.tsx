import { useState } from "react";

// A play-time limit in seconds (advance-on-end minimum / maximum; 0 = off) + its h/m/s reading. The field follows the
// owner's rule for settings number inputs, with the props of the shared `NumInput` (min / max / step / value /
// onChange — another UI lane's component, not on lp-player yet): free typing while focused (it can be emptied), only a
// complete in-range number commits live, and on blur / Enter the draft is clamped to min…max and saved (empty = min =
// off); Escape drops it. MERGE: replace the inner <input> with <NumInput {...same props} /> once it lands.
export function PlayTimeInput({ value, onChange, min = 0, max = 359999, step = 1, disabled, label }: {
  value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; disabled?: boolean; label?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const parse = (t: string) => { const n = Number(t.trim()); return t.trim() !== "" && Number.isFinite(n) ? Math.round(n / step) * step : null; };
  const commit = () => {
    if (draft === null) return;
    const n = parse(draft);
    const v = n === null ? min : Math.min(max, Math.max(min, n));
    setDraft(null);
    if (v !== value) onChange(v);
  };
  return (
    <span className="playtime">
      <input className="num" type="number" min={min} max={max} step={step} disabled={disabled} aria-label={label}
        value={draft ?? String(value)}
        onChange={(e) => {
          setDraft(e.target.value);
          const n = parse(e.target.value);
          if (n !== null && n >= min && n <= max && n !== value) onChange(n); // a complete in-range number: live
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          else if (e.key === "Escape") setDraft(null);
        }} />
      <span>s</span>
      {value > 0 && <span className="playtime-fmt">{fmtPlayTime(value)}</span>}
    </span>
  );
}

// 90 → "1 m 30 s", 3600 → "1 h", 0 → "off"
export function fmtPlayTime(sec: number): string {
  if (!sec) return "off";
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return [h ? `${h} h` : "", m ? `${m} m` : "", s ? `${s} s` : ""].filter(Boolean).join(" ");
}
