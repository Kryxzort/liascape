import { useSyncExternalStore } from "react";
import type { ClipQuality, LibraryOp } from "../api/client";
import { useStore } from "../store";
import { useLinger } from "../hooks/useLinger";
import { useMotion } from "./motion";
import { QUALITY_LABEL } from "./clipSource";

// The library's long background operations (the backend's Web/LibraryOps.cs: the preview clips following "Video preview
// quality", Steam's tags / trailers / frame sizes) as a thin line on the top bar's bottom edge, in Browse's load bar's place
// and look, with a small tab under it that says what and how far ("Making Low previews 42 / 318"). One line at a time:
// Browse's load bar takes the place while a page loads, and the first operation shown stays until it ends.
// Guard: --probe probe-libops.js (libops:*).
function opLabel(op: LibraryOp): string {
  if (op.id === "clips") return `Making ${QUALITY_LABEL[op.phase as ClipQuality] ?? op.phase} previews`;
  if (op.id === "facts") return op.phase === "steam" ? "Asking Steam for tags" : op.phase === "trailers" ? "Looking for trailers" : "Reading frame sizes";
  return "Updating the library";
}

// an operation over before this never shows: a line that flashes up for a moment says nothing
const SHOW_AFTER_MS = 500;
// the leave: the line fills to its end, then it and the tab fade (index.css .libops.closing)
const LEAVE_MS = 450;

// which operation the line shows: read here, outside React, so a timer can promote one once it has run SHOW_AFTER_MS
const since = new Map<string, number>();
let shown: LibraryOp | null = null;
let timer = 0;
const subs = new Set<() => void>();
function update() {
  const ops = useStore.getState().libraryOps, now = performance.now();
  for (const o of ops) if (!since.has(o.id)) since.set(o.id, now);
  for (const id of [...since.keys()]) if (!ops.some((o) => o.id === id)) since.delete(id);
  clearTimeout(timer);
  const next = (shown && ops.find((o) => o.id === shown!.id)) ?? ops.find((o) => now - since.get(o.id)! >= SHOW_AFTER_MS) ?? null;
  if (!next && ops.length) timer = window.setTimeout(update, Math.max(0, Math.min(...ops.map((o) => since.get(o.id)! + SHOW_AFTER_MS - now))) + 5);
  if (next !== shown) { shown = next; for (const f of subs) f(); }
}
useStore.subscribe((s, p) => { if (s.libraryOps !== p.libraryOps) update(); });
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };

export default function LibraryOpsLine() {
  const op = useSyncExternalStore(subscribe, () => shown);
  // Browse's load bar holds the place while a page of results loads
  const loading = useStore((s) => s.loading);
  const active = useStore((s) => s.appActive);
  const motion = useMotion();
  const { value: cur, closing } = useLinger(loading ? null : op, LEAVE_MS, motion);
  if (!cur) return null;
  const label = opLabel(cur);
  const frac = closing ? 1 : cur.total > 0 ? Math.min(1, cur.done / cur.total) : 0;
  return (
    <div className={`libops${closing ? " closing" : ""}${active ? "" : " idle"}`} data-libops={cur.id} role="progressbar"
      aria-label={label} aria-valuemin={0} aria-valuemax={cur.total} aria-valuenow={cur.done} aria-valuetext={`${label}: ${cur.done} of ${cur.total}`}>
      <div className="libops-fill" style={{ transform: `scaleX(${frac})` }} />
      <div className="libops-tab" aria-hidden><span className="libops-label">{label}</span><span className="libops-n">{cur.done} / {cur.total}</span></div>
    </div>
  );
}
