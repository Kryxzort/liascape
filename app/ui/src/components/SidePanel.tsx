import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X, Play, Image as ImageIcon, Film, TvMinimalPlay, Sparkles, Repeat } from "lucide-react";
import { captureSource } from "./motion";
import { YouTubeEmbed } from "./YouTubeEmbed";
import { type PreviewKind } from "../store";
import { type usePreview } from "./sidePreview";

// COOL: the Wallpaper Engine-style item sidebar (owner 2026-11-10: "instead of a settings menu when clicking right click
// and settings, it should open a sidebar when you focus a card and thats what has all the 4 options from the right click
// menu. same for the browse tab"; docs/superpowers/specs/2026-11-10-we-sidebar-design.md). One shell for the Library and
// the Browse sidebar: an <aside> beside the page (a sibling of `.scroll` inside `.app`), docked at ≥ 900 px — the grid
// and the playlist bar end at its left edge (index.css `.app:has(> .side-panel…)`) — and floating over the page with a
// scrim below that. It slides in on a slightly springy curve and its content follows in a quick stagger (picture → hero →
// actions → rows), a switch re-staggers the new item's content faster, it slides out on close (transform + opacity only,
// `:root.no-motion` → none of it). `id` is the item's IDENTITY (its path / page URL): a new copy of the same item
// (`library-item-changed`) is no new open — nothing replays (the 2026-11-10 morph-replay bug).
// Look (owner 2026-11-11: "very untasteful compared to the rest of the app"): the Settings page's language — accent-tinted
// section cards with glowing icon chips (`.side-sec`), the picture in a framed stage with a soft accent glow, action tiles.


// the head line for a focused card inside a multi-selection
export function SelectionNote({ n }: { n: number }) { return n > 1 ? <span className="shint side-sub">applies to {n} selected</span> : null; }

// the head's tool slot (before the close button): the content (keyed per item) portals its tools there — the Library
// sidebar's playlist toggle and, while the picture shows the YouTube trailer, its Play button
const HeadSlot = createContext<HTMLElement | null>(null);
export function SideHeadTools({ children }: { children: ReactNode }) {
  const slot = useContext(HeadSlot);
  return slot ? createPortal(children, slot) : null;
}

export function SidePanel({ kind, id, closing, title, sub, onClose, children }: {
  kind: "library" | "browse"; id: string; closing: boolean; title: string; sub?: ReactNode; onClose: () => void; children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  // the first item this panel opened on staggers in with the slide; a later one (a switch) re-staggers faster
  const [first] = useState(id);
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
          <div className="side-head-tools" ref={setSlot} />
          <button className="side-tool side-close" data-side-close title="Close (Esc)" aria-label="Close" onClick={onClose}><X size={16} /></button>
        </div>
        {/* keyed by the item: a switch remounts the content (its per-item state) and staggers it in */}
        <HeadSlot.Provider value={slot}>
          <div className={`side-content ${id === first ? "opening" : "swapping"}`} key={id}>{children}</div>
        </HeadSlot.Provider>
      </aside>
    </>
  );
}

// a section card in the Settings page's style: a glowing icon chip + an uppercase accent title, an accent edge on the left
export function SideSection({ icon, title, extra, children, ...rest }: {
  icon: ReactNode; title: string; extra?: ReactNode; children: ReactNode; [data: `data-${string}`]: string | boolean | undefined;
}) {
  return (
    <section className="side-sec" {...rest}>
      <h3 className="side-sec-title"><span className="side-sec-ico">{icon}</span>{title}{extra && <span className="side-sec-extra">{extra}</span>}</h3>
      {children}
    </section>
  );
}

const LABEL: Record<PreviewKind, string> = { gif: "GIF", video: "Video", youtube: "YouTube", image: "Picture" };
const ICON: Record<PreviewKind, ReactNode> = { gif: <Sparkles size={12} />, video: <Film size={12} />, youtube: <TvMinimalPlay size={13} />, image: <ImageIcon size={12} /> };
// the picture, bottom → top: the card's own still (cached — the first frame IS the card) → a sharp image (fades in once IT
// loaded) → the animated preview the switch picked: the gif / webp (the card's own /anim URL: the same image, the same
// animation), the video (from where the card's hover video was) or the YouTube trailer (muted — the desktop owns the sound;
// unmounted on a switch / close, which stops it). Layers cross-fade on opacity. At the picture's own aspect: read from the
// card's loaded image when the item is focused, else from an earlier visit, else 16:9 until the still loads — capped in
// height (index.css `.side-media`). `play`: the Library sidebar's picture is its Play control (owner 2026-11-11: the Play /
// In playlist row was "redundant clutter") — on hover a round accent Play button over a slightly scaled picture; already
// playing → the "Playing now" badge instead; on the trailer the embed takes the clicks (Play moves to the head).
const aspects = new Map<string, number>();
export function SideMedia({ id, cardId, base, full, gif, video, youtube, preview, play }: {
  id: string; cardId: string | null; base: string; full: string | null; gif: string | null; video: string | null; youtube: string | null;
  preview: ReturnType<typeof usePreview>;
  play?: { label: string; playing: boolean; looping: boolean; onPlay: () => void };
}) {
  const [src] = useState(() => captureSource(cardId)); // read once, at the focus (the card is on screen then)
  const [aspect, setAspect] = useState<number | null>(() => src.aspect ?? aspects.get(id) ?? null);
  const [fullOn, setFullOn] = useState<string | null>(null);
  const [vidOn, setVidOn] = useState<string | null>(null);
  const { mode, options, def, pick } = preview;
  // the video mounts the first time it's shown and stays (a switch back cross-fades instead of restarting); paused while hidden
  const [vidMounted, setVidMounted] = useState(false);
  if (mode === "video" && video && !vidMounted) setVidMounted(true);
  const vidRef = useRef<HTMLVideoElement>(null);
  useEffect(() => { const v = vidRef.current; if (!v) return; if (mode === "video") v.play().catch(() => {}); else v.pause(); }, [mode, vidMounted]);
  const a = aspect ?? 16 / 9;
  const known = (w: number, h: number) => { if (!w || !h) return; const r = w / h; aspects.set(id, r); if (aspect == null) setAspect(r); };
  const yt = mode === "youtube" && youtube;
  const playable = !!play && !play.playing && !yt;
  return (
    <div className="side-stage">
      <div className={`side-frame${playable ? " playable" : ""}${play?.playing ? " is-playing" : ""}`} style={{ aspectRatio: String(a), width: `min(100%, calc(var(--side-media-h) * ${a}))` }}>
        <div className="side-glow" aria-hidden />
        <div className="side-media" data-side-media data-preview-mode={mode}>
          {base && <img src={base} alt="" data-preview-layer="image" onLoad={(e) => known(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)} />}
          {full && <img className={`sm-full${fullOn === full ? " on" : ""}`} src={full} alt=""
            onLoad={(e) => { known(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight); setFullOn(full); }} />}
          {gif && <img className={`sm-anim${mode === "gif" ? " on" : ""}`} src={gif} alt="" data-preview-layer="gif" />}
          {video && vidMounted && <video ref={vidRef} className={`sm-anim${mode === "video" && vidOn === video ? " on" : ""}`} src={video} muted loop autoPlay playsInline
            data-preview-layer="video"
            onLoadedMetadata={(e) => { const v = e.currentTarget; if (src.videoTime != null && v.duration) v.currentTime = src.videoTime % v.duration; }}
            onPlaying={() => setVidOn(video)} />}
          {yt && <YouTubeEmbed url={youtube} onClose={() => pick(def)} />}
          {playable && (
            <button className="side-play" data-side-play aria-label={play.label} title={`${play.label} (Enter)`} onClick={play.onPlay}>
              <span className="side-play-ring"><Play size={22} fill="currentColor" /></span>
            </button>
          )}
          {play?.playing && (
            <span className="side-badge playing" data-side-playing>
              <span className="side-dot" />Playing now{play.looping && <><Repeat size={12} /> looping this one</>}
            </span>
          )}
        </div>
        {options.length > 0 && (
          <div className="side-switch" role="radiogroup" aria-label="Preview">
            {options.map((k) => (
              <button key={k} role="radio" aria-checked={mode === k} className={`side-sw${mode === k ? " on" : ""}`} data-preview-src={k}
                title={`Show the ${LABEL[k] === "Picture" ? "still picture" : LABEL[k]}`} onClick={() => pick(k)}>{ICON[k]}{LABEL[k]}</button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
