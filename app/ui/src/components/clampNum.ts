// Every numeric settings field (docs/decisions.md § "Let numeric fields be emptied while focused"). While it has
// focus the field shows exactly what was typed — empty, a
// lone "-", a value past min/max, a partial number — and only a draft that's a number within [min, max] is
// committed (`onChange` — so a valid value still applies live while typing, like every setting); an empty /
// out-of-range draft is never saved. On blur or Enter the draft is clamped (empty → min, or `emptyValue`),
// rounded to `integer`s when asked, committed, and the field shows the committed value again.
// The controlled `value` is what's saved; the draft lives here only while the field is focused.
export function clampNum(raw: string, min: number | undefined, max: number | undefined, fallback: number, integer: boolean): number {
  let n = raw.trim() === "" ? NaN : Number(raw);
  if (!Number.isFinite(n)) n = fallback;
  if (integer) n = Math.round(n);
  if (min != null && n < min) n = min;
  if (max != null && n > max) n = max;
  return n;
}
