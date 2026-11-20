import { useSyncExternalStore } from "react";
import type { ClipQuality, LibraryOp } from "../api/client";
import { useStore } from "../store";
import { QUALITY_LABEL } from "./clipSource";

// The library's long background operations (the backend's Web/LibraryOps.cs: the preview clips following "Video preview
// quality", the first clips of the cards on screen, Steam's tags / trailers / frame sizes, the sizes on disk, the scene and
// video loudness, imports, the unsubscribes reaching Steam) as the top bar shows them: the line (LibraryOpsLine.tsx) and the
// words in its status slot (TopbarStatus.tsx). Guard: --probe probe-libops.js (libops:*).
export function opLabel(op: LibraryOp): string {
  // API: ClipStore's queue: phase make = the cards' own first clips and the previews made ahead of their cards
  // (PreviewBackfill), else the quality a change of the setting makes
  if (op.id === "clips") return op.phase === "make" ? "Making previews" : `Making ${QUALITY_LABEL[op.phase as ClipQuality] ?? op.phase} previews`;
  if (op.id === "facts") return op.phase === "steam" ? "Asking Steam for tags" : op.phase === "trailers" ? "Looking for trailers"
    : op.phase === "disk" ? "Measuring sizes on disk" : "Reading frame sizes";
  if (op.id === "scene-loudness") return "Measuring scene loudness";
  if (op.id === "video-loudness") return "Measuring video loudness";
  // API: Web/FolderImportOps.cs, a folder import's or a watched folder's items landing
  if (op.id === "import") return "Importing";
  // API: Web/SteamOps.cs StartDrain, the user's own unsubscribes reaching Steam after their Undo window
  if (op.id === "unsubscribe") return "Unsubscribing";
  return "Updating the library";
}
// One item's work: a count ("0 / 1") tells nothing and a progress bar for one quick action is noise, so it shows only once it
// has run long (SHOW_SINGLE_AFTER_MS), as its words alone ("Unsubscribing…"): no count, no line (LibraryOpsLine.tsx).
// Guard: probe-libops libops:single
export const isSingle = (op: LibraryOp) => op.total < 2;
// the full wording of every shown operation: the line's accessible name and the status slot's tooltip
export const opsWords = (ops: LibraryOp[]) => ops.map((o) => isSingle(o) ? `${opLabel(o)}…` : `${opLabel(o)}: ${o.done} of ${o.total}`).join(", ");

// an operation over before this never shows: a line that flashes up for a moment says nothing
const SHOW_AFTER_MS = 500;
const SHOW_SINGLE_AFTER_MS = 3000;
const showAfter = (o: LibraryOp) => (isSingle(o) ? SHOW_SINGLE_AFTER_MS : SHOW_AFTER_MS);

// the shown operations, the first started first: each shows once it has run SHOW_AFTER_MS and stays until it ends, so the
// named one changes only when it ends (never a cycle between them). Read here, outside React, so a timer can promote one.
const since = new Map<string, number>();
let shown: LibraryOp[] = [];
let timer = 0;
const subs = new Set<() => void>();
function update() {
  const ops = useStore.getState().libraryOps, now = performance.now();
  for (const o of ops) if (!since.has(o.id)) since.set(o.id, now);
  for (const id of [...since.keys()]) if (!ops.some((o) => o.id === id)) since.delete(id);
  clearTimeout(timer);
  const ready = (o: LibraryOp) => shown.some((s) => s.id === o.id) || now - since.get(o.id)! >= showAfter(o);
  // sort is stable: operations seen together (a page opened mid-run) keep the backend's order
  const next = ops.filter(ready).sort((a, b) => since.get(a.id)! - since.get(b.id)!);
  const waiting = ops.filter((o) => !ready(o));
  if (waiting.length) timer = window.setTimeout(update, Math.max(0, Math.min(...waiting.map((o) => since.get(o.id)! + showAfter(o) - now))) + 5);
  if (next.length !== shown.length || next.some((o, i) => o !== shown[i])) { shown = next; for (const f of subs) f(); }
}
useStore.subscribe((s, p) => { if (s.libraryOps !== p.libraryOps) update(); });
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
export const useShownOps = () => useSyncExternalStore(subscribe, () => shown);

