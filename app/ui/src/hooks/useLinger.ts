import { useEffect, useState } from "react";
import { FADE_EXIT_MS } from "../components/motion";

// the item sidebar's exit slide (index.css `side-out`, .17 s)
export const SIDE_CLOSE_MS = 170;

// the last non-null value for `ms` after it went null (a panel's exit animation), `closing` meanwhile; motion off → for
// FADE_EXIT_MS (the exit is a fade then: components/motion.ts), never gone at once
export function useLinger<T>(v: T | null, ms: number, motion: boolean): { value: T | null; closing: boolean } {
  const [last, setLast] = useState<T | null>(v);
  if (v != null && v !== last) setLast(v); // follow a new value during render (no effect round-trip)
  useEffect(() => {
    if (v != null || last == null) return;
    const t = setTimeout(() => setLast(null), motion ? ms : FADE_EXIT_MS);
    return () => clearTimeout(t);
  }, [v, last, ms, motion]);
  return { value: v ?? last, closing: v == null && last != null };
}
