import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject, type SyntheticEvent } from "react";
import { motion as fm } from "framer-motion";
import { clipQualities, type ClipQualityInfo, type LibraryItem } from "../api/client";
import { useStore } from "../store";
import { LibraryCard } from "./LibraryCard";
import { hasGifAsset, previewVideo, useVideoOverGif, VIDEO_RE } from "./mediaAssets";
import { ClipExact, QUALITY_LABEL, useClipMaking, useClipQuality } from "./clipSource";
import { useMotion } from "./motion";
import { useLinger } from "../hooks/useLinger";
import { gridCardWidth } from "../hooks/useGridFit";

// Settings → Look & feel: a live preview of the Library's cards beside the card settings (views/Settings.tsx wraps that
// section in it). Real library items through the real LibraryCard, with the props the grid gives it (Library.tsx), so it
// can't drift from the grid: shape, size, the GIF / video toggles, video quality, glow and motion all show through the
// card's own code. It's a picture of the grid, not a second grid: hovering plays like a library card (the clip → real file
// hand-over included), and no click, double-click, right-click or key on it applies, plays or opens anything. Its video
// cards play the CHOSEN quality (ClipExact: a short sample of it, made in seconds), never the better clip the library keeps.
// Costs: the cards mount only while the card rows are on screen (an IntersectionObserver), so off screen nothing decodes;
// while the window is inactive the card's own gating stops every gif and clip (appActive). Sizes come from one
// ResizeObserver (read in its callback, after layout). Guard: probe-cardpreview (every cell).

// the side column must hold at least this much to sit beside the rows (one Small card and the caption); else it goes above
const MIN_SIDE = 220;
const EXIT_MS = 220;
// the frame's padding (set here, not in index.css, so the width sums below use the same number), and roughly what its
// header, caption and padding take of the height
const FRAME_PAD = 12;
const FRAME_CHROME = 96;
const noop = () => {};

// one item with a GIF preview only, one whose preview is its video only, one with both; the library's first of each, then any
// others to make two
function pickItems(items: LibraryItem[]): LibraryItem[] {
  const ok = items.filter((i) => !i.hasCrashed);
  const gifOnly = ok.find((i) => hasGifAsset(i) && previewVideo(i, true) === null);
  const videoOnly = ok.find((i) => !hasGifAsset(i) && previewVideo(i, false) !== null);
  const both = ok.find((i) => hasGifAsset(i) && !i.isScene && VIDEO_RE.test(i.videoPath));
  const picks = [gifOnly, videoOnly, both].filter((i): i is LibraryItem => !!i);
  for (const i of ok) { if (picks.length >= 2) break; if (!picks.includes(i)) picks.push(i); }
  return picks;
}

type Geo = { w: number; h: number; gap: number; col: number; side: boolean };
const sameGeo = (a: Geo | null, b: Geo) => !!a && a.w === b.w && a.h === b.h && a.gap === b.gap && a.col === b.col && a.side === b.side;

// swallow every activation inside the preview (capture phase: the card's own handlers never see it)
const swallow = (e: SyntheticEvent) => { e.stopPropagation(); e.preventDefault(); };
const fmtMb = (mb: number) => (mb < 10 ? mb.toFixed(1) : String(Math.round(mb)));

export function CardPreview({ scrollRef, rowsRef, children }: {
  scrollRef: RefObject<HTMLElement | null>; rowsRef: RefObject<HTMLElement | null>; children: ReactNode;
}) {
  const items = useStore((s) => s.libraryItems);
  const picks = useMemo(() => pickItems(items), [items]);
  const playingPath = useStore((s) => s.playingPath);
  const playlist = useStore((s) => s.playlist);
  // the grid's own gating (Library.tsx): gifs animate only while the window is active
  const autoPlayGifs = useStore((s) => !!s.settings?.autoPlayGifs && s.appActive);
  const size = useStore((s) => s.settings?.cardSize as string | undefined);
  const shape = useStore((s) => s.settings?.thumbnailAspect);
  const overGif = useVideoOverGif();
  const q = useClipQuality();
  const motion = useMotion();
  const has = picks.length > 0;

  // on screen: the card rows (not the preview: above the rows on a narrow window it may scroll off first)
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = rowsRef.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => setSeen(es[es.length - 1].isIntersecting));
    io.observe(el);
    return () => { io.disconnect(); setSeen(false); };
  }, [rowsRef]);
  const live = useLinger(seen && has ? true : null, EXIT_MS, motion);
  const mounted = !!live.value;

  // the grid's card width for this window, and the room the preview has
  const hostRef = useRef<HTMLDivElement>(null);
  const [geo, setGeo] = useState<Geo | null>(null);
  useEffect(() => {
    const sc = scrollRef.current, host = hostRef.current;
    if (!sc || !host || !has) return;
    const ro = new ResizeObserver(() => {
      // PERF: read inside the observer's callback, after this frame's layout: nothing is forced
      const cs = getComputedStyle(sc);
      const gap = parseFloat(cs.getPropertyValue("--gap")) || 14;
      const w = sc.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
      // the Library's grid counts its top padding at both ends (hooks/useGridFit.ts)
      const h = sc.clientHeight - 2 * (parseFloat(cs.paddingTop) || 0);
      const sec = host.parentElement?.querySelector(":scope > .ssection");
      const max = (sec && parseFloat(getComputedStyle(sec).maxWidth)) || w;
      const side = (w - Math.min(w, max)) / 2 >= MIN_SIDE;
      const hs = getComputedStyle(host);
      const col = Math.min(side ? Infinity : max, host.clientWidth - (parseFloat(hs.paddingLeft) || 0) - (parseFloat(hs.paddingRight) || 0));
      const next = { w, h, gap, col, side };
      setGeo((g) => (sameGeo(g, next) ? g : next));
    });
    ro.observe(sc);
    ro.observe(host);
    return () => ro.disconnect();
  }, [scrollRef, has]);

  // inside the preview, the card's own buttons are neither clicked nor tabbed to
  const cardsRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    for (const b of cardsRef.current?.querySelectorAll("button") ?? []) { b.inert = true; b.tabIndex = -1; }
  });

  const making = useClipMaking(mounted ? picks.map((i) => previewVideo(i, overGif)).filter((p): p is string => !!p) : [], q);
  const [qinfo, setQinfo] = useState<ClipQualityInfo[] | null>(null);
  // read when the preview shows and again once a clip is made (the store's median moved)
  useEffect(() => {
    if (!seen) return;
    let alive = true;
    clipQualities().then((r) => { if (alive) setQinfo(r); }).catch(() => {});
    return () => { alive = false; };
  }, [seen, making]);

  if (!has) return <div className="pv-wrap">{children}</div>;

  const n = picks.length;
  const aspect = shape === "16:9" ? 16 / 9 : 1;
  const g = geo?.gap ?? 14;
  let cw = geo ? gridCardWidth(geo.w, geo.h, g, size, shape) : 160;
  let perRow = n;
  if (geo) {
    const col = geo.col - 2 * FRAME_PAD;
    if (geo.side) {
      cw = Math.min(cw, col);
      perRow = Math.max(1, Math.min(n, Math.floor((col + g) / (cw + g))));
      // the whole stack stays within the window's height (it's pinned while the rows scroll)
      const rows = Math.ceil(n / perRow), room = geo.h - FRAME_CHROME;
      cw = Math.min(cw, ((room - (rows - 1) * g) / rows) * aspect);
    } else cw = Math.min(cw, (col - (n - 1) * g) / n);
    cw = Math.max(40, Math.floor(cw));
  }
  const rowW = perRow * cw + (perRow - 1) * g;
  const layoutOn = motion && mounted && !!geo;
  const quality = QUALITY_LABEL[q];
  const info = qinfo?.find((x) => x.name === q);
  const parts = making ? [`making the ${quality} preview…`] : info ? [quality, `${info.fps} fps`, `~${fmtMb(info.mb)} MB per wallpaper`] : [quality];
  const caption = parts.join(" · ");

  return (
    <div className="pv-wrap" data-side={geo?.side ? "" : undefined}>
      <div ref={hostRef} className="card-pv" data-card-preview={geo?.side ? "side" : "above"} data-on={seen ? "" : undefined}>
        <div className="card-pv-frame" role="group" aria-label="Card preview" aria-describedby="card-pv-cap"
          style={{ "--thumb-aspect": shape === "16:9" ? "16 / 9" : "1 / 1", width: rowW, padding: FRAME_PAD } as CSSProperties}>
          <div className="card-pv-h"><span>Preview</span><span className="card-pv-hint">hover to play</span></div>
          <div ref={cardsRef} className="card-pv-cards" aria-disabled="true"
            aria-label="Only a preview: hovering plays like your library, clicking applies nothing"
            onClickCapture={swallow} onDoubleClickCapture={swallow} onContextMenuCapture={swallow} onAuxClickCapture={swallow}
            onKeyDownCapture={swallow}>
            <ClipExact.Provider value={true}>
            {picks.map((it) => (
              // COOL: a size or shape change morphs each card to its new box (framer layout, transform only); motion off: no
              // layout node, so the change is instant (a 0 s layout transition still draws one frame at the old size).
              // PERF: layout only once the cards are mounted and sized (geo comes from the ResizeObserver): a layout node
              // mounting with Settings measures its scroll parents inside the tab click (forced layouts). Framer reads
              // `layout` only when the node is made, so the key remounts the slot when it flips (with the cards' own
              // first mount, so they aren't built twice). Guard: probe-cardpreview cardpv:motion, probe-layout perf:tabs.
              <fm.div key={`${it.videoPath}|${layoutOn}`} className="card-pv-slot" layout={layoutOn} transition={{ duration: 0.34, ease: [0.2, 0.8, 0.3, 1] }}
                style={{ width: cw }} data-pv-kind={hasGifAsset(it) ? (previewVideo(it, true) ? "both" : "gif") : "video"}>
                {mounted && <LibraryCard item={it} playing={it.videoPath === playingPath} selected={false} focused={false}
                  inPlaylist={playlist.includes(it.videoPath)} autoPlayGifs={autoPlayGifs}
                  onClick={noop} onTrash={noop} onToggle={noop} onContextFocus={noop} />}
              </fm.div>
            ))}
            </ClipExact.Provider>
          </div>
          <div className="card-pv-cap" id="card-pv-cap" aria-live="polite" data-making={making ? "" : undefined}>
            <span key={caption}>{parts.map((x, i) => <Fragment key={i}>{i ? " · " : ""}<i>{x}</i></Fragment>)}</span>
          </div>
        </div>
      </div>
      {children}
    </div>
  );
}
