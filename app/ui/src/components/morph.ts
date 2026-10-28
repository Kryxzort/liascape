// COOL: the per-item settings modal's morph (LibrarySettingsModal). A source surface (library card
// `.thumb-wrap`, playlist-strip `.pl-item`) carries `data-morph-id`; the modal's media box flies from that
// surface's visible crop to its own place — ONE uniform scale (the picture never stretches) while a
// clip-path inset re-crops it from the card's cover-crop to the image's own aspect — and a panel-coloured
// ghost grows from the card to the panel. framer's layoutId scaled one <img> between a 16:9 crop and the
// natural aspect (stretched mid-flight), flew a low-res still, and couldn't fly back out of the strip's
// scroll row (clipped there), so the strip close just vanished.

export type Box = { x: number; y: number; w: number; h: number };

// What the modal needs from the surface that opened it, read at the click: the card's animated layer
// unmounts the moment the modal opens (its time is gone by the modal's first render).
export type MorphSource = { aspect: number | null; videoTime: number | null };

export const boxOf = (el: Element): Box => { const b = el.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; };

export function sourceEl(morphId: string | null): HTMLElement | null {
  if (!morphId) return null;
  return document.querySelector<HTMLElement>(`[data-morph-id="${CSS.escape(morphId)}"]`);
}

// on screen at all (a card scrolled away, a collapsed strip → no flight, just a fade)
export function onScreen(b: Box): boolean {
  return b.w > 4 && b.h > 4 && b.x + b.w > 0 && b.y + b.h > 0 && b.x < innerWidth && b.y < innerHeight;
}

export function captureSource(morphId: string | null): MorphSource {
  const el = sourceEl(morphId);
  const vid = el?.querySelector<HTMLVideoElement>("video.thumb.anim");
  // the picture's aspect from whatever the source has loaded: its still, else its gif (a lazy still may
  // not have loaded yet while the gif plays over it — Browse), else its video
  let aspect: number | null = null;
  for (const i of el?.querySelectorAll<HTMLImageElement>("img.thumb:not(.anim), img.thumb.anim") ?? [])
    if (i.naturalWidth && i.naturalHeight) { aspect = i.naturalWidth / i.naturalHeight; break; }
  if (aspect == null && vid?.videoWidth && vid.videoHeight) aspect = vid.videoWidth / vid.videoHeight;
  return { aspect, videoTime: vid && !vid.paused ? vid.currentTime : null };
}

// the box of aspect `a` covering `s`, centred — where the whole picture is when `s` shows its cover-crop
export function cover(s: Box, a: number): Box {
  return s.w / s.h > a
    ? { x: s.x, y: s.y + (s.h - s.w / a) / 2, w: s.w, h: s.w / a }
    : { x: s.x + (s.w - s.h * a) / 2, y: s.y, w: s.h * a, h: s.h };
}

// keyframe for the media box (laid out at `m`, transform-origin 0 0) that shows exactly the source's
// crop `s` with corner radius `rs`: moved + uniformly scaled onto cover(s), clipped (in its own, unscaled
// coordinates) to s
export function onSource(m: Box, s: Box, rs: number, a: number): Keyframe {
  const c = cover(s, a);
  const k = c.w / m.w;
  const t = (s.y - c.y) / k, r = (c.x + c.w - s.x - s.w) / k, b = (c.y + c.h - s.y - s.h) / k, l = (s.x - c.x) / k;
  return {
    transform: `translate(${c.x - m.x}px, ${c.y - m.y}px) scale(${k})`,
    clipPath: `inset(${t}px ${r}px ${b}px ${l}px round ${rs / k}px)`,
  };
}

export const atRest = (radius: number): Keyframe => ({ transform: "translate(0px, 0px) scale(1)", clipPath: `inset(0px 0px 0px 0px round ${radius}px)` });

export const boxFrame = (b: Box, radius: number): Keyframe => ({ left: `${b.x}px`, top: `${b.y}px`, width: `${b.w}px`, height: `${b.h}px`, borderRadius: `${radius}px` });

// clip keyframes for an element laid out at `b` that keep it inside the ghost growing from `s` to the
// panel (which contains `b`): each clip edge runs from s's edge to b's with the same easing, so it never
// passes the ghost's edge (which runs to the panel's, further out). A polygon, not inset(): insets that
// add up to more than the box are scaled down proportionally — the edges would no longer track.
const rectPoly = (x0: number, y0: number, x1: number, y1: number) => `polygon(${x0}px ${y0}px, ${x1}px ${y0}px, ${x1}px ${y1}px, ${x0}px ${y1}px)`;
export const fromSourceClip = (b: Box, s: Box): Keyframe => ({ clipPath: rectPoly(s.x - b.x, s.y - b.y, s.x + s.w - b.x, s.y + s.h - b.y) });
export const fullClip = (b: Box): Keyframe => ({ clipPath: rectPoly(0, 0, b.w, b.h) });

export type MorphTiming = { open: { duration: number; easing: string }; close: { duration: number; easing: string } };

// a decelerating, slightly springy open; an ease-in-out close — the Browse preview's
export const OPEN = { duration: 430, easing: "cubic-bezier(0.2, 0.9, 0.22, 1)" };
export const CLOSE = { duration: 340, easing: "cubic-bezier(0.45, 0, 0.2, 1)" };
export const PREVIEW_MORPH: MorphTiming = { open: OPEN, close: CLOSE };
// COOL: the per-item settings modal flies slower (owner: "slow down morph" — 430 ms with an ease that does ~70 %
// of the travel in its first quarter read as a snap): a longer, gentler ease-out open whose travel is spread over
// the whole flight, and a matching ease-in-out close. Things that wait for the open to land (the duration row,
// the scene properties, App's frozen gifs) key off these numbers.
export const SETTINGS_MORPH: MorphTiming = {
  open: { duration: 620, easing: "cubic-bezier(0.3, 0.7, 0.2, 1)" },
  close: { duration: 500, easing: "cubic-bezier(0.45, 0, 0.25, 1)" },
};
