import { useState, type InputHTMLAttributes } from "react";
import { clampNum } from "./clampNum";

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "min" | "max" | "type"> & {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  /** what an emptied field commits on blur (default: min, else 0) */
  emptyValue?: number;
  /** whole numbers only (default true unless `step` has a fraction) */
  integer?: boolean;
};

export function NumInput({ value, onChange, min, max, emptyValue, integer, step, className = "num", onBlur, onFocus, onKeyDown, ...rest }: Props) {
  const [draft, setDraft] = useState<string | null>(null); // non-null while focused
  const whole = integer ?? !(typeof step === "number" && !Number.isInteger(step));
  const inRange = (n: number) => (min == null || n >= min) && (max == null || n <= max);
  const commit = (raw: string) => {
    const v = clampNum(raw, min, max, emptyValue ?? min ?? 0, whole);
    if (v !== value) onChange(v);
    return v;
  };
  return (
    <input {...rest} className={className} type="number" min={min} max={max} step={step}
      value={draft ?? String(value)}
      onFocus={(e) => { setDraft(String(value)); onFocus?.(e); }}
      onChange={(e) => {
        const raw = e.target.value;
        // set without focus (a script, a test driver): nothing to wait for — commit it clamped now
        if (document.activeElement !== e.target) { commit(raw); return; }
        setDraft(raw);
        const n = raw.trim() === "" ? NaN : Number(raw);
        // a complete in-range number applies at once (settings apply live); anything else waits for the blur
        if (Number.isFinite(n) && inRange(n) && (!whole || Number.isInteger(n)) && n !== value) onChange(n);
      }}
      onBlur={(e) => { if (draft != null) commit(draft); setDraft(null); onBlur?.(e); }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && draft != null) setDraft(String(commit(draft)));
        onKeyDown?.(e);
      }} />
  );
}
