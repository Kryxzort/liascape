import { useEffect, useState } from "react";

// the item sidebar's exit slide (index.css `side-out`)
export const SIDE_CLOSE_MS = 160;

// the last non-null value for `ms` after it went null (a panel's exit animation), `closing` meanwhile; motion off → gone
// on the next tick
export function useLinger<T>(v: T | null, ms: number, motion: boolean): { value: T | null; closing: boolean } {
  const [last, setLast] = useState<T | null>(v);
  if (v != null && v !== last) setLast(v); // follow a new value during render (no effect round-trip)
  useEffect(() => {
    if (v != null || last == null) return;
    const t = setTimeout(() => setLast(null), motion ? ms : 0);
    return () => clearTimeout(t);
  }, [v, last, ms, motion]);
  return { value: v ?? last, closing: v == null && last != null };
}
