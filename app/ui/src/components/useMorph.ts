import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { bezier, boxOf, cssEase, flightFrames, lerpPose, onScreen, PREVIEW_MORPH, restPose, sourceEl, sourcePose, type Flight, type MorphTiming, type Pose, type Rest } from "./morph";

// COOL: a modal that morphs out of the surface carrying `data-morph-id={morphId}` and back into it
// (components/morph.ts has the geometry and why it's transform-only). Wire the returned refs: `panelRef` on
// the `.morph-panel` (its `::before` is the panel's chrome — background, border, shadow — and flies),
// `mediaRef` on its `[data-morph-media]` box (sized at the picture's `aspect`) whose ONE child
// `[data-morph-pic]` holds the picture layers, `bodyRef` on a `.morph-clip` wrapping the `.modal-body`; close
// with `requestClose` (Escape is wired). `open` = what's open (a new value → a new flight); `ready` = the
// picture's aspect is known (the flight waits for it, ≤ 300 ms, panel hidden — a box re-laid out mid-flight
// jumps); `landed` turns true once its open flight finished (mount heavy layers after it — a decode
// mid-flight hitches the animation, worst in the software-rendered UI). `timing` = the flight durations +
// easings (morph.ts: the Browse preview's by default, SETTINGS_MORPH slower).
export function useMorph({ open, ready, morphId, aspect, onClose, timing = PREVIEW_MORPH }: { open: unknown; ready: boolean; morphId: string | null; aspect: number; onClose: () => void; timing?: MorphTiming }) {
  const { open: OPEN, close: CLOSE } = timing;
  const panelRef = useRef<HTMLDivElement>(null);
  const mediaRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const closingRef = useRef(false);
  const flightRef = useRef(0); // the newest flight; an older one's finish must not tidy up after a newer one
  const animsRef = useRef<Animation[]>([]); // the running flight's animations
  const openRef = useRef<{ from: Pose; to: Pose } | null>(null); // the open flight, while it runs (a close turns it around)
  const [landedFor, setLandedFor] = useState<unknown>(null);
  const [gaveUpFor, setGaveUpFor] = useState<unknown>(null); // stopped waiting for `ready`
  const go = !!open && (ready || gaveUpFor === open);
  useEffect(() => {
    if (!open || ready) return;
    const t = setTimeout(() => setGaveUpFor(open), 300);
    return () => clearTimeout(t);
  }, [open, ready]);

  const parts = () => {
    const panel = panelRef.current!, media = mediaRef.current!, clip = bodyRef.current!;
    return { panel, media, pic: media.querySelector<HTMLElement>("[data-morph-pic]") ?? media, clip, body: (clip.firstElementChild as HTMLElement | null) ?? clip };
  };
  const stop = () => { animsRef.current.forEach((a) => a.cancel()); animsRef.current = []; };
  // the untransformed boxes (call with no flight applied)
  const rest = (): Rest => { const { panel, media, clip } = parts(); return { M: boxOf(media), P: boxOf(panel), B: boxOf(clip) }; };

  // one flight from → to (screen poses): every part on transform only; the body's opacity on its clip box
  const run = (R: Rest, from: Pose, to: Pose, f: Flight, fade: Keyframe[], fadeMs = f.duration): Animation[] => {
    const { panel, media, pic, clip, body } = parts();
    panel.dataset.morph = "1"; // will-change + the clip box's overflow, for the flight only (index.css)
    const k = flightFrames(R, from, to, bezier(f.bezier), f.duration);
    const opt: KeyframeAnimationOptions = { duration: f.duration, easing: "linear", fill: "both" };
    const anims = [
      media.animate(k.media, opt),
      pic.animate(k.pic, opt),
      panel.animate(k.chrome, { ...opt, pseudoElement: "::before" }),
      clip.animate(k.clip, opt),
      body.animate(k.body, opt),
      clip.animate(fade, { duration: fadeMs, easing: cssEase(f.bezier), fill: "both" }),
    ];
    animsRef.current = anims;
    return anims;
  };

  useLayoutEffect(() => {
    if (!open) return;
    closingRef.current = false;
    openRef.current = null;
    const panel = panelRef.current;
    if (panel) panel.style.visibility = go ? "" : "hidden"; // waiting for the aspect
    if (!go) return;
    const src = sourceEl(morphId);
    const S = src ? boxOf(src) : null;
    if (!src || !S || !onScreen(S) || !panel) {
      panel?.animate([{ opacity: 0, transform: "scale(0.97)" }, { opacity: 1, transform: "scale(1)" }], { duration: 200, easing: "ease-out" })
        .finished.then(() => setLandedFor(open), () => {});
      return;
    }
    stop();
    const R = rest();
    const from = sourcePose(S, aspect), to = restPose(R);
    const flight = ++flightRef.current;
    const anims = run(R, from, to, OPEN, [{ opacity: 0 }, { opacity: 0, offset: 0.35 }, { opacity: 1 }]);
    openRef.current = { from, to };
    anims[0].finished.then(() => {
      if (flight !== flightRef.current) return;
      openRef.current = null;
      stop(); // every part's last frame is its rest pose: no visual change
      delete panel.dataset.morph;
      setLandedFor(open);
    }, () => {});
    // the NEWEST flight on purpose: a close that already took over must keep running
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => { if (flight === flightRef.current) { stop(); openRef.current = null; } };
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
    if (!panel || !src || !S || !onScreen(S) || !mediaRef.current || !bodyRef.current) {
      if (!panel) { onClose(); return; }
      stop();
      panel.animate([{ opacity: 1, transform: "scale(1)" }, { opacity: 0, transform: "scale(0.97)" }], { duration: 160, easing: "ease-in", fill: "both" })
        .finished.then(onClose, onClose);
      return;
    }
    flightRef.current++; // an open still flying must not tidy up any more
    // PERF: a playing preview video (often the 4K wallpaper itself, software-decoded) holds its frame for the
    // flight back — a new decoded frame every 33 ms costs the software-rendered flight its smoothness
    mediaRef.current.querySelectorAll("video").forEach((v) => v.pause());
    const to = sourcePose(S, aspect);
    // still flying open (a quick Escape / double click): from the pose it's in now, decelerate into the
    // source (reversing replayed the open's ease-out backwards — it hit the card at full speed)
    const o = openRef.current, a0 = animsRef.current[0];
    if (o && a0 && a0.playState === "running") {
      const p = bezier(OPEN.bezier)(Math.min(1, Number(a0.currentTime ?? 0) / OPEN.duration));
      const op = +getComputedStyle(bodyRef.current).opacity;
      stop(); openRef.current = null;
      const R = rest(); // the rest boxes NOW — the panel may have re-laid out since
      land(run(R, lerpPose(o.from, o.to, p), to, CLOSE, [{ opacity: op }, { opacity: 0 }], CLOSE.duration * 0.35)[0]);
      return;
    }
    stop(); openRef.current = null;
    const R = rest();
    land(run(R, restPose(R), to, CLOSE, [{ opacity: 1 }, { opacity: 0, offset: 0.35 }, { opacity: 0 }])[0]);
  };
  const closeRef = useRef(requestClose);
  useEffect(() => { closeRef.current = requestClose; });
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") closeRef.current(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open]);

  return { panelRef, mediaRef, bodyRef, requestClose, landed: !!open && landedFor === open };
}
