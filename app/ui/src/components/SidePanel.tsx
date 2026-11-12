import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { X, Image as ImageIcon, Film, TvMinimalPlay, Sparkles, Volume2, VolumeX, AppWindow } from "lucide-react";
import { captureSource, sourceEl, useMotion, FADE_EXIT_MS } from "./motion";
import { YouTubeEmbed } from "./YouTubeEmbed";
import { Segmented } from "./Segmented";
import { type PreviewKind, useStore } from "../store";
import { useStableFn } from "../hooks/useStableFn";
import { api } from "../api/client";
import { type usePreview, usePreviewSound, previewLevel, setPreviewVolume, setPreviewMuted, followWallpaper, unmutePreview, rangeFill } from "./sidePreview";

// COOL: the Wallpaper Engine-style item sidebar (docs/decisions.md § "Replace the card settings and preview modals with an
// item sidebar"; docs/superpowers/specs/2026-11-10-we-sidebar-design.md). One shell for the Library and
// the Browse sidebar: an <aside> beside the page (a sibling of `.scroll` inside `.app`), docked at ≥ 900 px — the grid
// and the playlist bar end at its left edge (index.css `.app:has(> .side-panel…)`) — and floating over the page with a
// scrim below that. It slides in on a slightly springy curve and its content follows in a quick stagger (picture → hero →
// actions → rows), a switch re-staggers the new item's content faster, it slides out on close (transform + opacity only;
// `:root.no-motion` → it fades in and out, and a switch cross-fades). `id` is the item's IDENTITY (its path / page URL): a
// new copy of the same item (`library-item-changed`) is no new open — nothing replays.
// Look: the Settings page's language — accent-tinted
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

// A switch slides like a carousel, not a crossfade: the direction is where the new item's card sits on screen relative to the old one's (`card` = the
// cards' `data-morph-id`, measured at the switch) — a row below → the new content rises from below and the old leaves
// upwards, a row above → mirrored, the same row → sideways (right of it → in from the right, the old out left). No card to
// measure (filtered out / scrolled away from a content-visibility grid) → `order`, the item's index in the list: later =
// from the right. The outgoing content stays mounted (same key, so nothing reloads — its video keeps playing) in a layer
// laid over the new one (after it in the DOM: a lookup finds the live content first), `inert`, its head tools withheld, for
// SIDE_SLIDE_MS. Neither known → the old quick re-stagger. Motion off → the same exit layer, cross-fading (FADE_EXIT_MS)
// whatever the direction (index.css :root.no-motion .side-exit). Guard: probe-sidebar lib:slide, motion:off
export const SIDE_SLIDE_MS = 300;
type Dir = "right" | "left" | "down" | "up";
type Shown = { id: string; order: number; card?: string; node: ReactNode };
type Exit = Shown & { dir: Dir | null };
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
  const [exit, setExit] = useState<Exit | null>(null);
  const [dir, setDir] = useState<Dir | null>(null);
  if (cur.id !== id) {
    const d = slideDir(cur, { order, card });
    setFirst(null);
    setDir(d);
    setExit(!motion ? { ...cur, dir: null } : d ? { ...cur, dir: d } : null);
    setCur({ id, order, card, node: children });
  } else if (cur.node !== children || cur.order !== order || cur.card !== card) setCur({ id, order, card, node: children });
  useEffect(() => {
    if (!exit) return;
    const t = setTimeout(() => setExit(null), exit.dir ? SIDE_SLIDE_MS : FADE_EXIT_MS);
    return () => clearTimeout(t);
  }, [exit]);
  // a new item scrolls the panel back to its top (the old one's scroll position means nothing for it)
  // PERF: only when it IS scrolled (tracked from its scroll events): a scrollTo forces a layout of the panel's just-swapped
  // content inside the right-click / key press. Guard: probe-layout perf:sidebar.
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrolled = useRef(false);
  useEffect(() => { if (scrolled.current) scrollRef.current?.scrollTo({ top: 0 }); }, [id]);
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
        <div className="side-scroll" ref={scrollRef} onScroll={(e) => { scrolled.current = e.currentTarget.scrollTop > 0; }}>
        <div className="side-track">
          <div className={`side-content ${id === first ? "opening" : dir ? IN[dir] : "swapping"}`} key={id}>
            <HeadSlot.Provider value={slot}>{children}</HeadSlot.Provider>
          </div>
          {exit && (
            <div className={`side-content side-exit ${exit.dir ? OUT[exit.dir] : "fade"}`} key={exit.id} inert aria-hidden>
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
// animation), the video (from where the card's hover video was) or the YouTube trailer (both at the previews' remembered mute and
// level, sidePreview.ts; the trailer is unmounted on a switch / close, which stops it). Layers cross-fade on opacity. At the picture's own aspect: read from the
// card's loaded image when the item is focused, else from an earlier visit, else 16:9 until the still loads — capped in
// height (index.css `.side-stage`). `play`: the Library sidebar's picture is its Play control (docs/decisions.md § "Make
// the sidebar's picture the Play control") — no icon, the hover cue is the picture with its strip lifting 1.025× with their
// glow; already playing → the green frame (no badge: the card and the frame already say it — "looping" is the hero's chip); on the trailer the embed takes the clicks (Play moves to the head).
const aspects = new Map<string, number>();
// `wall`: the item's effective wallpaper volume (`override ?? global`), the previews' level until the user sets their own.
// `files`: the local files behind the Video / GIF / Picture layers (a library item's, a local folder's Browse item's); the
// picture gets an "open in your default app" button while a layer with one shows (SideOpen). A Workshop preview is remote: none.
export function SideMedia({ id, cardId, base, full, gif, video, youtube, preview, wall, play, files }: {
  id: string; cardId: string | null; base: string; full: string | null; gif: string | null; video: string | null; youtube: string | null;
  preview: ReturnType<typeof usePreview>; wall: number;
  play?: { label: string; playing: boolean; looping: boolean; onPlay: () => void };
  files?: { video: string | null; gif: string | null; image: string | null };
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
  // the Video preview's sound: the previews' remembered mute and level (sidePreview.ts previewSound); a level of 0 is silent too
  const sound = usePreviewSound();
  const level = previewLevel(sound, wall);
  const silent = sound.muted || level === 0;
  useEffect(() => { const v = vidRef.current; if (v) v.volume = level / 100; }, [level, vidMounted]);
  // The cleanup pauses: the Library stays mounted behind another tab (App.tsx <Activity>), and a hidden <video> keeps
  // playing its sound; hiding runs this cleanup and showing again re-runs the effect. A layout effect: Activity runs its
  // cleanup in the commit that hides the page (a passive one can land frames later, still sounding).
  // Guard: probe-sidebar preview:hiddenTab
  useLayoutEffect(() => {
    const v = vidRef.current; if (!v) return;
    if (mode === "video") v.play().catch(() => {}); else v.pause();
    return () => v.pause();
  }, [mode, vidMounted]);
  const a = aspect ?? 16 / 9;
  // the frame takes the SHOWN preview's own shape (a 16:9 video cover-cropped into a square picture's frame loses its
  // sides): the picture / gif → the picture's aspect, Video
  // → the video's own (from its metadata), the YouTube trailer → 16:9. The rows below move with it on a switch.
  const [vidAspect, setVidAspect] = useState<number | null>(null);
  const shape = mode === "video" && video && vidAspect ? vidAspect : mode === "youtube" && youtube ? 16 / 9 : a;
  const known = (w: number, h: number) => { if (!w || !h) return; const r = w / h; aspects.set(id, r); if (aspect == null) setAspect(r); };
  const yt = mode === "youtube" && youtube;
  const playable = !!play && !play.playing && !yt;
  return (
    // one shape: the strip's rounded top, the picture's rounded bottom, no gap; the glow, the playing ring and the
    // hover grow wrap the whole unit (index.css `.side-stage`). Guard: probe-sidebar look:strip, lib:play.
    <div className={`side-stage${options.length > 0 ? " has-switch" : ""}${playable ? " playable" : ""}${play?.playing ? " is-playing" : ""}`}
      data-side-playing={play?.playing ? "" : undefined} style={{ width: `min(100%, calc(var(--side-media-h) * ${shape}))` }}>
      <div className="side-glow" aria-hidden />
      {options.length > 0 && (
        <Segmented variant="strip" label="Preview" value={mode} onChange={pick}
          options={options.map((k) => ({ value: k, label: LABEL[k], icon: ICON[k], attrs: { "data-preview-src": k } }))} />
      )}
      <div className="side-frame" data-shape={shape.toFixed(3)} style={{ aspectRatio: String(shape) }}>
        <div className="side-media" data-side-media data-preview-mode={mode}>
          {base && <img src={base} alt="" data-preview-layer="image" onLoad={(e) => known(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)} />}
          {full && <img className={`sm-full${fullOn === full ? " on" : ""}`} src={full} alt=""
            onLoad={(e) => { known(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight); setFullOn(full); }} />}
          {gif && <img className={`sm-anim${mode === "gif" ? " on" : ""}`} src={gif} alt="" data-preview-layer="gif" />}
          {video && vidMounted && <video ref={vidRef} className={`sm-anim${mode === "video" && vidOn === video ? " on" : ""}`} src={video} muted={silent} loop autoPlay playsInline
            data-preview-layer="video"
            onLoadedMetadata={(e) => { const v = e.currentTarget; if (v.videoWidth && v.videoHeight) setVidAspect(v.videoWidth / v.videoHeight);
              if (src.videoTime != null && v.duration) v.currentTime = src.videoTime % v.duration; }}
            onPlaying={() => setVidOn(video)} />}
          {yt && <YouTubeEmbed url={youtube} level={level} />}
          {/* above the click-to-play layer (z 3): a press here never applies the wallpaper */}
          {mode === "video" && video && vidOn === video && <PreviewVolume wall={wall} />}
          {(files?.video && video || files?.gif && gif || files?.image) && (
            <SideOpen file={mode === "video" ? (video && files?.video) || null : mode === "gif" ? (gif && files?.gif) || null
              : mode === "image" ? files?.image ?? null : null} />
          )}
          {playable && (
            <button className="side-play" data-side-play aria-label={play.label} onClick={play.onPlay} />
          )}
        </div>
      </div>
    </div>
  );
}

// The shown Video / GIF / Picture in the desktop's default app for its type (POST /open/media: a library video or picture
// only, checked by name and content). AppWindow — an app's window, not ExternalLink's "a web page". The mute chip's twin in
// the opposite corner — its size, inset and fill (index.css `.side-open`). Mounted while the item has a file behind any layer,
// shown only while such a layer is picked (not the YouTube trailer): it fades in and out with the switch (opacity; motion
// off the same fade), inert while hidden. Above the click-to-play layer and stopping its clicks: a press here never applies
// the wallpaper. Guard: probe-sidebar preview:open, look:previewOpen.
function SideOpen({ file }: { file: string | null }) {
  const [last, setLast] = useState(file);
  if (file && file !== last) setLast(file); // the label stays while it fades out
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
  return (
    <button className={`side-open${file ? " on" : ""}`} data-side-open={last ?? ""} inert={!file} aria-hidden={!file || undefined}
      aria-label="Open in your default app" title="Open in your default app"
      onPointerDown={stop} onDoubleClick={stop}
      onClick={(e) => { e.stopPropagation(); if (file) api.openMedia(file).catch((err) => useStore.getState().setError(`Couldn't open it: ${(err as Error).message}`)); }}>
      <AppWindow size={16} />
    </button>
  );
}

// The Video preview's sound: the mute chip in the picture's corner, and beside it — revealed while the chip or the control is
// hovered, a slider in it is held, or the keyboard is in it — the previews' own volume slider, in a dark pill like the preview
// strip's. Mute and level compose: the slider shows 0 while muted and moving it unmutes; dragged to 0 it shows the muted
// glyph, and unmuting from there brings back the last audible level. Wheel over the chip or the slider steps the level
// (≈ 5 per notch); Tab reaches the chip, then the slider (arrows / PageUp / PageDown / Home / End). Above the click-to-play
// layer (z 3) and stopping its clicks: a press here never applies the wallpaper.
// Guard: probe-sidebar preview:volume, preview:volumeLook.
const WHEEL_PX_PER_STEP = 24;
// The slider's notch sits at the wallpaper's own volume. A new level that lands close enough to it snaps onto it and the
// preview follows the wallpaper again (the way back after moving the preview's own slider); anywhere else is the
// preview's own level. Guard: probe-sidebar preview:notch
// "Close enough" is a few points either side, and only on the way IN: a level already on the notch (or inside the band)
// that moves away by one arrow key or wheel step must leave it, or the notch would hold the level and swallow every
// small step.
const NOTCH_SNAP = 3;
function snapsToWallpaper(v: number, from: number, wall: number): boolean {
  if (v === wall) return true;
  return Math.abs(v - wall) <= NOTCH_SNAP && Math.abs(from - wall) > NOTCH_SNAP;
}

function PreviewVolume({ wall }: { wall: number }) {
  const sound = usePreviewSound();
  const level = previewLevel(sound, wall);
  const clampWall = Math.max(0, Math.min(100, Math.round(wall)));
  const silent = sound.muted || level === 0;
  const shown = silent ? 0 : level;
  // several wheel events can land before React renders the last one's level: step from the level the last one asked for
  const wheelAt = useRef({ v: 0, t: -Infinity });
  // the glyph pops on a change the user made, never when the chip first shows
  const [touched, setTouched] = useState(false);
  const following = sound.own == null;
  const change = (v: number) => {
    setTouched(true);
    if (snapsToWallpaper(v, shown, clampWall)) followWallpaper(); else setPreviewVolume(v);
    if (v > 0) setPreviewMuted(false);
  };
  const toggle = () => {
    setTouched(true); wheelAt.current.t = -Infinity;
    if (silent) unmutePreview(wall); else setPreviewMuted(true);
  };
  const step = useStableFn((n: number) => {
    const now = performance.now(), base = now - wheelAt.current.t < 150 ? wheelAt.current.v : shown;
    const v = Math.max(0, Math.min(100, base + n));
    wheelAt.current = { v, t: now };
    if (v !== base) change(v);
  });
  // the wheel needs a non-passive listener (React's is passive) so the sidebar doesn't scroll under it
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    let acc = 0;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault(); e.stopPropagation();
      acc -= e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY;
      const steps = Math.trunc(acc / WHEEL_PX_PER_STEP);
      if (!steps) return;
      acc -= steps * WHEEL_PX_PER_STEP;
      step(steps);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [step]);
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
  return (
    <div ref={ref} className="side-vol" data-side-vol onClick={stop} onPointerDown={stop} onDoubleClick={stop}>
      <button className={`side-mute${silent ? "" : " on"}`} data-side-mute aria-pressed={!silent} aria-label={silent ? "Unmute the preview" : "Mute the preview"}
        onClick={toggle}>
        {/* keyed by the state: the new glyph pops once on a change (icon motion: toggle) */}
        <span className={`side-mute-ico${touched ? " ico-pop" : ""}`} key={silent ? "off" : "on"}>{silent ? <VolumeX size={16} /> : <Volume2 size={16} />}</span></button>
      <div className="side-vol-slide">
        <span className={`side-vol-val${following ? " follow" : ""}`} aria-hidden>{shown}</span>
        <span className="side-vol-track">
          <i className={`side-vol-notch${following ? " on" : ""}`} style={{ "--at": clampWall / 100 } as CSSProperties} aria-hidden />
          <input type="range" min={0} max={100} step={1} value={shown} style={rangeFill(shown, 0, 100)} data-side-vol-range
          aria-label="Preview volume" aria-valuetext={silent ? "muted" : `${shown}%${following ? ", following the wallpaper" : ""}`} onChange={(e) => change(+e.target.value)} />
        </span>
      </div>
    </div>
  );
}
