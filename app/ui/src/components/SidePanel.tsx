import { useEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { captureSource } from "./motion";

// COOL: the Wallpaper Engine-style item sidebar (owner 2026-11-10: "instead of a settings menu when clicking right click
// and settings, it should open a sidebar when you focus a card and thats what has all the 4 options from the right click
// menu. same for the browse tab"; docs/superpowers/specs/2026-11-10-we-sidebar-design.md). One shell for the Library and
// the Browse sidebar: an <aside> beside the page (a sibling of `.scroll` inside `.app`), docked at ≥ 900 px — the grid
// and the playlist bar end at its left edge (index.css `.app:has(> .side-panel…)`) — and floating over the page with a
// scrim below that. It slides in on open, cross-fades its content on an item switch, slides out on close (transform +
// opacity only, `:root.no-motion` → none of it). `id` is the item's IDENTITY (its path / page URL): a new copy of the same
// item (`library-item-changed`) is no new open — nothing replays (the 2026-11-10 morph-replay bug).


// the head line for a focused card inside a multi-selection
export function SelectionNote({ n }: { n: number }) { return n > 1 ? <span className="shint side-sub">applies to {n} selected</span> : null; }

export function SidePanel({ kind, id, closing, title, sub, onClose, children }: {
  kind: "library" | "browse"; id: string; closing: boolean; title: string; sub?: ReactNode; onClose: () => void; children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  // a new item scrolls the panel back to its top (the old one's scroll position means nothing for it)
  useEffect(() => { ref.current?.scrollTo({ top: 0 }); }, [id]);
  return (
    <>
      {/* narrow windows: the panel floats over the page; a click beside it closes it (index.css shows it < 900 px only) */}
      <div className={`side-scrim${closing ? " closing" : ""}`} onClick={onClose} />
      <aside ref={ref} className={`side-panel${closing ? " closing" : ""}`} data-side={kind} data-side-id={id}>
        <div className="side-head">
          <div className="side-head-text">
            <h2 title={title}>{title}</h2>
            {sub}
          </div>
          <button className="mini side-close" data-side-close title="Close (Esc)" onClick={onClose}><X size={16} /></button>
        </div>
        {/* keyed by the item: a switch remounts the content (its per-item state) and cross-fades it in */}
        <div className="side-content" key={id}>{children}</div>
      </aside>
    </>
  );
}

// the picture, bottom → top: the card's own still (cached — the first frame IS the card) → a sharp image (fades in once IT
// loaded) → the animated preview: a gif / webp (the card's own /anim URL: the same image, the same animation) or a video
// (from where the card's hover video was). At the picture's own aspect: read from the card's loaded image when the item is
// focused, else from an earlier visit, else 16:9 until the still loads — capped in height (index.css `.side-media`).
const aspects = new Map<string, number>();
export function SideMedia({ id, cardId, base, full, gif, video, overlay }: {
  id: string; cardId: string | null; base: string; full: string | null; gif: string | null; video: string | null; overlay?: ReactNode;
}) {
  const [src] = useState(() => captureSource(cardId)); // read once, at the focus (the card is on screen then)
  const [aspect, setAspect] = useState<number | null>(() => src.aspect ?? aspects.get(id) ?? null);
  const [fullOn, setFullOn] = useState<string | null>(null);
  const [vidOn, setVidOn] = useState<string | null>(null);
  const a = aspect ?? 16 / 9;
  const known = (w: number, h: number) => { if (!w || !h) return; const r = w / h; aspects.set(id, r); if (aspect == null) setAspect(r); };
  return (
    <div className="side-stage">
      <div className="side-media" data-side-media style={{ aspectRatio: String(a), width: `min(100%, calc(var(--side-media-h) * ${a}))` }}>
        {base && <img src={base} alt="" onLoad={(e) => known(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)} />}
        {full && <img className={`sm-full${fullOn === full ? " on" : ""}`} src={full} alt=""
          onLoad={(e) => { known(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight); setFullOn(full); }} />}
        {gif && <img className="sm-anim" src={gif} alt="" />}
        {!gif && video && <video className={`sm-anim${vidOn === video ? " on" : ""}`} src={video} muted loop autoPlay playsInline
          onLoadedMetadata={(e) => { const v = e.currentTarget; if (src.videoTime != null && v.duration) v.currentTime = src.videoTime % v.duration; }}
          onPlaying={() => setVidOn(video)} />}
      </div>
      {overlay}
    </div>
  );
}
