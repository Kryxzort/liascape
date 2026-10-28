import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { atRest, boxFrame, boxOf, fromSourceClip, fullClip, onScreen, onSource, PREVIEW_MORPH, sourceEl, type Box, type MorphTiming } from "./morph";

const MEDIA_RADIUS = 14;

// an element's untransformed box, from its offsetParent (the positioned panel) — offset* ignore transforms
const restBox = (panel: HTMLElement, el: HTMLElement): Box => {
  const p = panel.getBoundingClientRect();
  return { x: p.left + panel.clientLeft + el.offsetLeft, y: p.top + panel.clientTop + el.offsetTop, w: el.offsetWidth, h: el.offsetHeight };
};

// COOL: a modal that morphs out of the surface carrying `data-morph-id={morphId}` and back into it
// (components/morph.ts has the geometry). Wire the returned refs: `ghostRef` on a `.morph-ghost` sibling
// BEFORE the panel, `panelRef` on the `.morph-panel`, `mediaRef` on its `[data-morph-media]` box (sized at
// the picture's `aspect`), `bodyRef` on the text below it; close with `requestClose` (Escape is wired).
// `open` = what's open (a new value → a new flight); `ready` = the picture's aspect is known (the flight
// waits for it, ≤ 300 ms, panel hidden — a box re-laid out mid-flight jumps); `landed` turns true once
// its open flight finished (mount heavy layers after it — a big decode mid-flight hitches the animation).
// `timing` = the flight durations + easings (morph.ts: the Browse preview's by default, SETTINGS_MORPH slower).
export function useMorph({ open, ready, morphId, aspect, onClose, timing = PREVIEW_MORPH }: { open: unknown; ready: boolean; morphId: string | null; aspect: number; onClose: () => void; timing?: MorphTiming }) {
  const { open: OPEN, close: CLOSE } = timing;
  const panelRef = useRef<HTMLDivElement>(null);
  const mediaRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const closingRef = useRef(false);
  const flightRef = useRef(0); // the newest flight; an older one's finish must not tidy up after a newer one
  const openAnimsRef = useRef<Animation[]>([]); // the open flight, while it runs (a close turns it around)
  const [landedFor, setLandedFor] = useState<unknown>(null);
  const [gaveUpFor, setGaveUpFor] = useState<unknown>(null); // stopped waiting for `ready`
  const geomRef = useRef<{ M: Box; B: Box; rs: number } | null>(null); // the open flight's layout
  const go = !!open && (ready || gaveUpFor === open);
  useEffect(() => {
    if (!open || ready) return;
    const t = setTimeout(() => setGaveUpFor(open), 300);
    return () => clearTimeout(t);
  }, [open, ready]);

  // media box: source crop → its place (uniform scale + re-crop); ghost: source → panel; the body stays
  // inside the growing ghost and fades in late (out early)
  const fly = (src: HTMLElement, S: Box, dir: "open" | "close"): Animation[] => {
    const panel = panelRef.current!, mediaEl = mediaRef.current!, ghost = ghostRef.current!, body = bodyRef.current!;
    for (const el of [panel, mediaEl, ghost, body]) el.getAnimations().forEach((a) => a.cancel());
    delete panel.dataset.morph;
    const P = boxOf(panel), M = boxOf(mediaEl), B = boxOf(body);
    const pcs = getComputedStyle(panel);
    const rs = parseFloat(getComputedStyle(src).borderTopLeftRadius) || 8;
    geomRef.current = { M, B, rs };
    const rp = parseFloat(pcs.borderTopLeftRadius) || 16;
    Object.assign(ghost.style, { display: "block", background: pcs.backgroundColor, border: pcs.border, boxShadow: pcs.boxShadow });
    panel.dataset.morph = "1";
    const flight = ++flightRef.current;
    const opt = { ...(dir === "open" ? OPEN : CLOSE), fill: "both" as FillMode };
    const way = (k: Keyframe[]) => (dir === "open" ? k : [...k].reverse());
    const anims = [
      mediaEl.animate(way([onSource(M, S, rs, aspect), atRest(MEDIA_RADIUS)]), opt),
      ghost.animate(way([boxFrame(S, rs), boxFrame(P, rp)]), opt),
      body.animate(way([fromSourceClip(B, S), fullClip(B)]), opt),
      body.animate(dir === "open" ? [{ opacity: 0 }, { opacity: 0, offset: 0.35 }, { opacity: 1 }] : [{ opacity: 1 }, { opacity: 0, offset: 0.35 }, { opacity: 0 }], opt),
    ];
    if (dir === "open")
      anims[0].finished.then(() => {
        if (flight !== flightRef.current) return;
        delete panel.dataset.morph; ghost.style.display = "none";
        anims.forEach((a) => a.cancel());
        setLandedFor(open);
      }, () => {});
    return anims;
  };

  useLayoutEffect(() => {
    if (!open) return;
    closingRef.current = false;
    openAnimsRef.current = [];
    const panel = panelRef.current;
    if (panel) panel.style.visibility = go ? "" : "hidden"; // waiting for the aspect
    if (!go) return;
    const src = sourceEl(morphId);
    const S = src ? boxOf(src) : null;
    if (!src || !S || !onScreen(S) || !panelRef.current) {
      panelRef.current?.animate([{ opacity: 0, transform: "scale(0.97)" }, { opacity: 1, transform: "scale(1)" }], { duration: 200, easing: "ease-out" })
        .finished.then(() => setLandedFor(open), () => {});
      return;
    }
    const anims = fly(src, S, "open");
    openAnimsRef.current = anims;
    return () => anims.forEach((a) => a.cancel());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, go]);

  // unmount one frame after landing, so the landing pose itself gets painted
  const land = (a: Animation) => a.finished.then(() => requestAnimationFrame(() => onClose()), onClose);

  // back into the source — wherever it is NOW (the strip may have scrolled); gone/offscreen → fade out
  const requestClose = () => {
    if (closingRef.current) return;
    closingRef.current = true;
    const src = sourceEl(morphId);
    const S = src ? boxOf(src) : null;
    const panel = panelRef.current;
    // still flying open (a quick Escape / double click): from the pose it's in now, decelerate into the
    // source (reversing replayed the open's ease-out backwards — it hit the card at full speed)
    const opening = openAnimsRef.current, g = geomRef.current;
    if (opening.length && opening.every((a) => a.playState === "running") && src && S && onScreen(S) && g) {
      flightRef.current++; // the open's tidy-up must not run any more
      const mediaEl = mediaRef.current!, ghost = ghostRef.current!, body = bodyRef.current!;
      for (const a of opening) { a.commitStyles(); a.cancel(); }
      // the rest boxes NOW (offset* ignore the media's transform) — the panel may have re-laid out since
      g.M = restBox(panel!, mediaEl); g.B = boxOf(body);
      const opt = { ...CLOSE, fill: "both" as FillMode };
      const anims = [
        mediaEl.animate([onSource(g.M, S, g.rs, aspect)], opt),
        ghost.animate([boxFrame(S, g.rs)], opt),
        body.animate([fromSourceClip(g.B, S)], opt),
        body.animate([{ opacity: 0 }], { ...opt, duration: CLOSE.duration * 0.35 }),
      ];
      land(anims[0]);
      return;
    }
    if (!panel || !src || !S || !onScreen(S)) {
      if (!panel) { onClose(); return; }
      panel.animate([{ opacity: 1, transform: "scale(1)" }, { opacity: 0, transform: "scale(0.97)" }], { duration: 160, easing: "ease-in", fill: "both" })
        .finished.then(onClose, onClose);
      return;
    }
    land(fly(src, S, "close")[0]);
  };
  const closeRef = useRef(requestClose);
  useEffect(() => { closeRef.current = requestClose; });
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") closeRef.current(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open]);

  return { panelRef, mediaRef, ghostRef, bodyRef, requestClose, landed: !!open && landedFor === open };
}
