import { Check, Hash } from "lucide-react";
import { useCopied } from "../hooks/useCopied";

// The item sidebars' Workshop ID (LibrarySide.tsx, BrowseSide.tsx): a pill among the hero's facts that copies itself and turns
// into a green "Copied" for a moment (hooks/useCopied.ts — keyed by the id, so another item's sidebar never says "Copied").
// Both faces share one grid cell (index.css .xfade): the wider sets the pill's width in either state, so "Copied" never changes
// it and the row never re-wraps; the hidden face is aria-hidden and the name is the aria-label.
// Guard: probe-steam side:idPill:still, side:copyIdPill, probe-settings copy:sidebarPill
export function WorkshopIdPill({ id }: { id: string }) {
  const [copiedId, copy] = useCopied();
  const copied = copiedId === id;
  return (
    <button className={`side-pill copy${copied ? " done" : ""}`} data-side-row="workshop-id" data-copy-id data-copied={copied ? "" : undefined}
      title="Copy the Workshop ID" aria-label={`Workshop ID ${id} — ${copied ? "copied" : "copy"}`} onClick={() => copy(id)}>
      <span className="xfade">
        <span data-off={copied ? "" : undefined} aria-hidden={copied}><Hash size={13} /> {id}</span>
        <span data-off={copied ? undefined : ""} aria-hidden={!copied}><Check size={13} className={copied ? "ico-pop" : undefined} /> Copied</span>
      </span>
    </button>
  );
}
