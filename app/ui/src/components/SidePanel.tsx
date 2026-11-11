import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X, Image as ImageIcon, Film, TvMinimalPlay, Sparkles, Volume2, VolumeX } from "lucide-react";
import { captureSource, sourceEl, useMotion } from "./motion";
import { YouTubeEmbed } from "./YouTubeEmbed";
import { useStore, type PreviewKind } from "../store";
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

// A switch slides like a carousel (owner 2026-11-11: "instead of a crossfade, it slides to the next wallpaper's sidebar menu
// depending on where it is respective to the current one" + "it should also slide differently based on whether the next one
// is above or below"): the direction is where the new item's card sits on screen relative to the old one's (`card` = the
// cards' `data-morph-id`, measured at the switch) — a row below → the new content rises from below and the old leaves
// upwards, a row above → mirrored, the same row → sideways (right of it → in from the right, the old out left). No card to
// measure (filtered out / scrolled away from a content-visibility grid) → `order`, the item's index in the list: later =
// from the right. The outgoing content stays mounted (same key, so nothing reloads — its video keeps playing) in a layer
// laid over the new one (after it in the DOM: a lookup finds the live content first), `inert`, its head tools withheld, for
// SIDE_SLIDE_MS. Neither known → the old quick re-stagger. Motion off → an instant swap.
export const SIDE_SLIDE_MS = 300;
type Dir = "right" | "left" | "down" | "up";
type Shown = { id: string; order: number; card?: string; node: ReactNode };
function slideDir(a: Shown, b: { order: number; card?: string }): Dir | null {
  const ra = sourceEl(a.card ?? null)?.getBoundingClientRect(), rb = sourceEl(b.card ?? null)?.getBoundingClientRect();
  if (ra && rb && ra.width && rb.width) {
    const dy = rb.top + rb.height / 2 - (ra.top + ra.height / 2), dx = rb.left + rb.width / 2 - (ra.left + ra.width / 2);
    if (Math.abs(dy) > Math.min(ra.height, rb.height) / 2) return dy > 0 ? "down" : "up";
    if (Math.abs(dx) > 1) return dx > 0 ? "right" : "left";
  }
  return a.order >= 0 && b.order >= 0 && a.order !== b.order ? (b.order > a.order ? "right" : "left") : null;
}
const IN: Record<Dir, string> = { right: "slide-next", left: "slide-prev", down: "slide-below", up: "slide-above" };
const OUT: Record<Dir, string> = { right: "to-left", left: "to-right", down: "to-top", up: "to-bottom" };
export function SidePanel({ kind, id, order = -1, card, closing, title, sub, onClose, children }: {
  kind: "library" | "browse"; id: string; order?: number; card?: string; closing: boolean; title: string; sub?: ReactNode; onClose: () => void; children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const motion = useMotion();
  // the first item this panel opened on staggers in with the slide; a later one slides (or re-staggers faster)
  // (cleared on the first switch: coming back to that item later is a switch too, not the opening)
  const [first, setFirst] = useState<string | null>(id);
  // follow the shown item during render (no effect round-trip, like useLinger): the last children per item, so a switch
  // still has the outgoing item's content to slide out
  const [cur, setCur] = useState<Shown>({ id, order, card, node: children });
  const [exit, setExit] = useState<(Shown & { dir: Dir }) | null>(null);
  const [dir, setDir] = useState<Dir | null>(null);
  if (cur.id !== id) {
    const d = slideDir(cur, { order, card });
    setFirst(null);
    setDir(d);
    setExit(d && motion ? { ...cur, dir: d } : null);
    setCur({ id, order, card, node: children });
  } else if (cur.node !== children || cur.order !== order || cur.card !== card) setCur({ id, order, card, node: children });
  useEffect(() => {
    if (!exit) return;
    const t = setTimeout(() => setExit(null), SIDE_SLIDE_MS);
    return () => clearTimeout(t);
  }, [exit]);
  // a new item scrolls the panel back to its top (the old one's scroll position means nothing for it)
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => { scrollRef.current?.scrollTo({ top: 0 }); }, [id]);
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
          <button className="side-tool side-close" data-side-close aria-label="Close" onClick={onClose}><X size={16} /></button>
        </div>
        {/* keyed by the item: a switch remounts the content (its per-item state) and slides / staggers it in; the outgoing
            one keeps its key (no remount) in the exit layer — same element types in both slots, so nothing remounts as it
            moves there */}
        {/* the content scrolls BELOW the head (not under a sticky one): in live-wallpaper mode the panel is as see-through as
            the cards' name bars, and content sliding under a translucent head would show through it */}
        <div className="side-scroll" ref={scrollRef}>
        <div className="side-track">
          <div className={`side-content ${id === first ? "opening" : dir ? IN[dir] : "swapping"}`} key={id}>
            <HeadSlot.Provider value={slot}>{children}</HeadSlot.Provider>
          </div>
          {exit && (
            <div className={`side-content side-exit ${OUT[exit.dir]}`} key={exit.id} inert aria-hidden>
              <HeadSlot.Provider value={null}>{exit.node}</HeadSlot.Provider>
            </div>
          )}
        </div>
        </div>
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
// In playlist row was "redundant clutter") — no icon (owner: clicking the picture is intuitive), the hover cue is the frame lifting 1.025× with its glow; already
// playing → the green frame (no badge: owner 2026-11-11, the card and the frame already say it — "looping" is the hero's chip); on the trailer the embed takes the clicks (Play moves to the head).
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
  const { mode, options, pick } = preview;
  // the video mounts the first time it's shown and stays (a switch back cross-fades instead of restarting); paused while hidden
  const [vidMounted, setVidMounted] = useState(false);
  if (mode === "video" && video && !vidMounted) setVidMounted(true);
  const vidRef = useRef<HTMLVideoElement>(null);
  // the Video preview's sound (owner 2026-11-11: "in video, show a button to mute/unmute"): muted by default — the desktop's
  // wallpaper owns the sound — unmuted at the app's global volume; a new item (a remount) starts muted again
  const [vidMuted, setVidMuted] = useState(true);
  const appVolume = useStore((s) => Number(s.settings?.volume ?? 100));
  useEffect(() => { const v = vidRef.current; if (v) v.volume = Math.max(0, Math.min(1, (Number.isFinite(appVolume) ? appVolume : 100) / 100)); }, [appVolume, vidMounted]);
  useEffect(() => { const v = vidRef.current; if (!v) return; if (mode === "video") v.play().catch(() => {}); else v.pause(); }, [mode, vidMounted]);
  const a = aspect ?? 16 / 9;
  // the frame takes the SHOWN preview's own shape (owner 2026-11-11: the 16:9 video was cover-cropped into the square
  // picture's frame — its sides cut off; they chose "the frame reshapes"): the picture / gif → the picture's aspect, Video
  // → the video's own (from its metadata), the YouTube trailer → 16:9. The rows below move with it on a switch.
  const [vidAspect, setVidAspect] = useState<number | null>(null);
  const shape = mode === "video" && video && vidAspect ? vidAspect : mode === "youtube" && youtube ? 16 / 9 : a;
  const known = (w: number, h: number) => { if (!w || !h) return; const r = w / h; aspects.set(id, r); if (aspect == null) setAspect(r); };
  const yt = mode === "youtube" && youtube;
  const playable = !!play && !play.playing && !yt;
  return (
    <div className={`side-stage${options.length > 0 ? " has-switch" : ""}`}>
      {/* the preview switch: a strip attached to the stage's top edge, above the picture (owner 2026-11-11: "in a attached
          field above the preview instead of a overlay") */}
      {options.length > 0 && (
        <div className="side-switch" role="radiogroup" aria-label="Preview">
          {options.map((k) => (
            <button key={k} role="radio" aria-checked={mode === k} className={`side-sw${mode === k ? " on" : ""}`} data-preview-src={k}
              onClick={() => pick(k)}>{ICON[k]}{LABEL[k]}</button>
          ))}
        </div>
      )}
      <div className={`side-frame${playable ? " playable" : ""}${play?.playing ? " is-playing" : ""}`} data-side-playing={play?.playing ? "" : undefined} data-shape={shape.toFixed(3)} style={{ aspectRatio: String(shape), width: `min(100%, calc(var(--side-media-h) * ${shape}))` }}>
        <div className="side-glow" aria-hidden />
        <div className="side-media" data-side-media data-preview-mode={mode}>
          {base && <img src={base} alt="" data-preview-layer="image" onLoad={(e) => known(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)} />}
          {full && <img className={`sm-full${fullOn === full ? " on" : ""}`} src={full} alt=""
            onLoad={(e) => { known(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight); setFullOn(full); }} />}
          {gif && <img className={`sm-anim${mode === "gif" ? " on" : ""}`} src={gif} alt="" data-preview-layer="gif" />}
          {video && vidMounted && <video ref={vidRef} className={`sm-anim${mode === "video" && vidOn === video ? " on" : ""}`} src={video} muted={vidMuted} loop autoPlay playsInline
            data-preview-layer="video"
            onLoadedMetadata={(e) => { const v = e.currentTarget; if (v.videoWidth && v.videoHeight) setVidAspect(v.videoWidth / v.videoHeight);
              if (src.videoTime != null && v.duration) v.currentTime = src.videoTime % v.duration; }}
            onPlaying={() => setVidOn(video)} />}
          {yt && <YouTubeEmbed url={youtube} />}
          {/* above the click-to-play layer (z 3): a press here never applies the wallpaper */}
          {mode === "video" && video && vidOn === video && (
            <button className={`side-mute${vidMuted ? "" : " on"}`} data-side-mute aria-pressed={!vidMuted} aria-label={vidMuted ? "Unmute the preview" : "Mute the preview"}
              onClick={(e) => { e.stopPropagation(); setVidMuted((m) => !m); }}>
              {vidMuted ? <VolumeX size={16} /> : <Volume2 size={16} />}</button>
          )}
          {playable && (
            <button className="side-play" data-side-play aria-label={play.label} onClick={play.onPlay} />
          )}
        </div>
      </div>
    </div>
  );
}
