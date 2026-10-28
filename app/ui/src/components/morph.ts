// COOL: the card → modal morph (LibrarySettingsModal, PreviewModal — the useMorph hook). A source surface
// (library card `.thumb-wrap`, playlist-strip `.pl-item`, Browse card) carries `data-morph-id`; the modal's
// media box flies from that surface's visible crop to its own place — the picture with ONE uniform scale (it
// never stretches) while its crop grows from the card's cover-crop to the image's own aspect — the panel's
// chrome (its `::before`: background, border, shadow) grows from the card to the panel, and the body is
// clipped to it. framer's layoutId scaled one <img> between a 16:9 crop and the natural aspect (stretched
// mid-flight), flew a low-res still, and couldn't fly back out of the strip's scroll row (clipped there).
//
// PERF: every flight animates `transform` (+ the body's opacity) ONLY — compositor work, no layout, no
// repaint. The owner's NVIDIA box renders the UI in software (main.js: disable-gpu), where the old flight
// (the ghost's left/top/width/height/border-radius + its 60 px shadow re-rastered every frame, clip-path
// re-crops repainting the media and the body) spent ~6 ms of raster + ~5 ms of compositing per frame and
// dropped about half the frames of a 240 Hz display. A re-crop without clip-path = two nested boxes: the
// outer one (overflow hidden, rounded) scaled NON-uniformly onto the crop, the inner one counter-scaled so
// the content's net scale is the picture's (uniform) — or 1 for the body, which stays put while its clip
// grows. Nested scales interpolate per factor, not per product, so the keyframes are SAMPLED (the easing
// baked in, `linear` between samples, ~one per 12 ms) and the product stays exact to a fraction of a pixel.

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

const lerp = (a: number, b: number, p: number) => a + (b - a) * p;
export const lerpBox = (a: Box, b: Box, p: number): Box => ({ x: lerp(a.x, b.x, p), y: lerp(a.y, b.y, p), w: lerp(a.w, b.w, p), h: lerp(a.h, b.h, p) });

// One frame of a flight, every box on screen (px): V = the media's visible crop, C = the whole picture
// (V's cover box — same aspect all the way, so a box lerp between two of them never stretches it),
// G = the panel chrome (the "ghost"), R = the body's visible clip. Each edge runs linearly between two
// poses (the same eased progress for all), so V ⊂ G and R ⊂ G all the way when they hold at both ends.
export type Pose = { V: Box; C: Box; G: Box; R: Box };
export const sourcePose = (S: Box, aspect: number): Pose => ({ V: S, C: cover(S, aspect), G: S, R: S });
// at rest: M = the media box, P = the panel, B = the body (their untransformed boxes)
export type Rest = { M: Box; P: Box; B: Box };
export const restPose = ({ M, P, B }: Rest): Pose => ({ V: M, C: M, G: P, R: B });
export const lerpPose = (a: Pose, b: Pose, p: number): Pose => ({ V: lerpBox(a.V, b.V, p), C: lerpBox(a.C, b.C, p), G: lerpBox(a.G, b.G, p), R: lerpBox(a.R, b.R, p) });

// the transform (transform-origin 0 0) that puts an element laid out at `rest` onto the screen box `t`
const mapTo = (rest: Box, t: Box) => `translate(${t.x - rest.x}px, ${t.y - rest.y}px) scale(${t.w / rest.w}, ${t.h / rest.h})`;
// an inner box laid out over its outer one (inset 0, both at `rest`), the outer mapped onto `V`: the
// inner's transform (in the outer's scaled coordinates) that puts its content on the screen box `C`
const innerTo = (rest: Box, V: Box, C: Box) => {
  const sx = V.w / rest.w, sy = V.h / rest.h;
  return `translate(${(C.x - V.x) / sx}px, ${(C.y - V.y) / sy}px) scale(${C.w / V.w}, ${C.h / V.h})`;
};

// CSS cubic-bezier(x1, y1, x2, y2) as a function of time fraction → progress
export type Bezier = [number, number, number, number];
export function bezier([x1, y1, x2, y2]: Bezier): (t: number) => number {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const X = (s: number) => ((ax * s + bx) * s + cx) * s, Y = (s: number) => ((ay * s + by) * s + cy) * s;
  const dX = (s: number) => (3 * ax * s + 2 * bx) * s + cx;
  return (t) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    let s = t;
    for (let i = 0; i < 8; i++) { const e = X(s) - t, d = dX(s); if (Math.abs(e) < 1e-6) return Y(s); if (Math.abs(d) < 1e-6) break; s -= e / d; }
    let lo = 0, hi = 1; s = t;
    for (let i = 0; i < 40; i++) { const x = X(s); if (Math.abs(x - t) < 1e-6) break; if (x < t) lo = s; else hi = s; s = (lo + hi) / 2; }
    return Y(s);
  };
}
export const cssEase = (b: Bezier) => `cubic-bezier(${b.join(", ")})`;

// the keyframes of a flight `from` → `to` (eased by `ease`, sampled — see the header), for: the media box
// (outer crop) + its `[data-morph-pic]` (inner picture), the panel's `::before` (chrome) and the body's
// clip box + the body inside it. Apply each with `easing: "linear"`.
export type FlightFrames = { media: Keyframe[]; pic: Keyframe[]; chrome: Keyframe[]; clip: Keyframe[]; body: Keyframe[] };
export function flightFrames(rest: Rest, from: Pose, to: Pose, ease: (t: number) => number, duration: number): FlightFrames {
  const n = Math.max(8, Math.ceil(duration / 12));
  const f: FlightFrames = { media: [], pic: [], chrome: [], clip: [], body: [] };
  for (let i = 0; i <= n; i++) {
    const offset = i / n, q = lerpPose(from, to, ease(offset));
    f.media.push({ offset, transform: mapTo(rest.M, q.V) });
    f.pic.push({ offset, transform: innerTo(rest.M, q.V, q.C) });
    f.chrome.push({ offset, transform: mapTo(rest.P, q.G) });
    f.clip.push({ offset, transform: mapTo(rest.B, q.R) });
    f.body.push({ offset, transform: innerTo(rest.B, q.R, rest.B) });
  }
  return f;
}

export type Flight = { duration: number; bezier: Bezier };
export type MorphTiming = { open: Flight; close: Flight };

// the Browse preview's: a decelerating, slightly springy open; an ease-in-out close
export const PREVIEW_MORPH: MorphTiming = {
  open: { duration: 430, bezier: [0.2, 0.9, 0.22, 1] },
  close: { duration: 340, bezier: [0.45, 0, 0.2, 1] },
};
// COOL: TUNE HERE — the per-item settings modal's flight (owner 2026-10-28: 430 ms "snap" → 620 ms "still too
// snappy"): slow and soft, one symmetric ease-in-out (sine-like: 25 % of the time → 15 % of the travel, the
// middle fastest, the landing as gentle as the take-off) both ways, the close a little quicker than the open.
// Things that wait for the open to land (the duration row, the scene properties, the video preview, App's
// frozen gifs) key off these numbers; probe-morph.js asserts the flight times around them.
const SOFT: Bezier = [0.37, 0, 0.63, 1];
export const SETTINGS_MORPH: MorphTiming = {
  open: { duration: 900, bezier: SOFT },
  close: { duration: 700, bezier: SOFT },
};
