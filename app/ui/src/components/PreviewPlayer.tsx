import { useEffect, useRef, useState } from "react";
import { useMotion } from "./motion";

// A card's preview video, and the hand-over between two of them without a visible seam (components/MotionThumb.tsx): a
// clip → the wallpaper's own file on hover and back, the 10 s stand-in → the full clip, a narrower clip → a wider one. All
// of them share the video's timeline (a clip is the video from its start), so the new one starts where the old one is:
// it loads hidden under the old one, seeks a little ahead of it (LEAD: what its seek takes), starts as the old one reaches
// that moment, and shows only once a frame of its own has come out within a frame or two of the old one's time (its
// playbackRate nudged meanwhile if it drifts). Until then the old one plays on screen. Motion off: a plain swap.
// Guard: matrix clip:hoverHandoff, clip:shortToFull.

// PERF: an unmounted <video> doesn't stop loading: Chromium keeps a detached element that still has network activity
// alive, with its decoder and its HTTP connection (one of the 6 to the backend) — a few hovers and scrolls later no
// other video loads at all. Drop the source on the way out, which aborts the load at once. Guard: matrix
// appear:videoThumbs (the scrolled-away videos).
function useReleaseOnUnmount(ref: React.RefObject<HTMLVideoElement | null>) {
  useEffect(() => {
    const v = ref.current;
    return () => { if (v) { v.removeAttribute("src"); v.load(); } };
  }, [ref]);
}
function Layer({ src, shown, vref, onError, onFrame }: { src: string; shown: boolean; vref: (v: HTMLVideoElement | null) => void;
  onError?: () => void; onFrame?: () => void }) {
  const ref = useRef<HTMLVideoElement>(null);
  useReleaseOnUnmount(ref);
  const set = (v: HTMLVideoElement | null) => { ref.current = v; vref(v); };
  // the incoming layer isn't `.anim` (what the page and its probes read as the card's video) and sits under the shown one
  return <video ref={set} className={shown ? "thumb anim" : "thumb"} src={src} muted loop autoPlay={shown} playsInline preload="auto"
    style={shown ? undefined : { position: "absolute", inset: 0 }} onError={onError} onLoadedData={onFrame} />;
}

// what a seek has taken lately (s), per kind of file, starting from what was measured: a 1080p-4K wallpaper's own file
// 40-215 ms (median 86), a clip 2-8 ms
const seekCost = { real: 0.15, clip: 0.02 };
const FRAME = 1 / 30; // the clips' coarsest frame step (Low is 24 fps: a frame and a half of tolerance covers it)

export function PreviewPlayer({ src, real, onError }: { src: string; real: boolean; onError?: () => void }) {
  const motion = useMotion();
  const [shownSrc, setShownSrc] = useState(src);
  const [next, setNext] = useState<{ src: string; real: boolean } | null>(null);
  // the shown one has a frame on screen (else there is nothing to keep seamless)
  const [curReady, setCurReady] = useState(false);
  const cur = useRef<HTMLVideoElement | null>(null);
  const inc = useRef<HTMLVideoElement | null>(null);
  // a new source: hand over to it (or, motion off or nothing shown yet, swap at once); back to what shows: drop the hand-over
  if (src !== shownSrc && next?.src !== src) {
    if (!motion || !curReady) { setShownSrc(src); setCurReady(false); if (next) setNext(null); }
    else setNext({ src, real });
  } else if (src === shownSrc && next) setNext(null);

  useEffect(() => {
    if (!next) return;
    const a = cur.current, b = inc.current;
    if (!a || !b) return;
    const kind = next.real ? "real" : "clip";
    let raf = 0, target = -1, armedAt = 0, close = 0, presented = -1, tries = 0, done = false, playedAt = 0;
    const lead = () => Math.min(2, seekCost[kind] * 1.5 + 0.05);
    const promote = () => { done = true; b.playbackRate = 1; setShownSrc(next.src); setCurReady(b.readyState >= 2); setNext(null); };
    const arm = () => {
      const end = Math.min(a.duration || Infinity, b.duration || Infinity);
      const t = a.currentTime + lead();
      // the new one is shorter than where the old one is (the stand-in clip under a long file): no moment to meet at
      if (a.currentTime >= (b.duration || Infinity) - 0.1) { promote(); return; }
      // too close to the loop's end: meet after the old one wraps
      if (t > end - 0.15) { target = -1; return; }
      if (++tries > 8) { promote(); return; }
      b.pause(); target = t; armedAt = performance.now(); b.currentTime = t; close = 0; presented = -1; playedAt = 0;
    };
    const onSeeked = () => { if (armedAt) { const s = (performance.now() - armedAt) / 1000; seekCost[kind] = seekCost[kind] * 0.6 + s * 0.4; armedAt = 0; } };
    b.addEventListener("seeked", onSeeked);
    // a frame of the new one actually came out: its media time (the reveal waits for one near the old one's time)
    const watchFrames = () => {
      if (done || !b.requestVideoFrameCallback) return;
      b.requestVideoFrameCallback((_n, m) => { presented = m.mediaTime; watchFrames(); });
    };
    watchFrames();
    const tick = () => {
      if (done) return;
      raf = requestAnimationFrame(tick);
      if (b.readyState < 1) return;
      const now = a.currentTime;
      // the old one stands still (stalled, paused): nothing moves to stay in step with
      if (a.paused) { if (!b.seeking && b.readyState >= 2) promote(); return; }
      if (target < 0) { arm(); return; }
      if (b.paused) {
        if (b.seeking) return;
        // the old one ran past the meeting point while the new one sought: meet later, with more lead
        if (now > target + FRAME) { seekCost[kind] = Math.max(seekCost[kind], (now - target) + lead()); arm(); return; }
        if (now >= target - FRAME / 2 && b.readyState >= 2) { playedAt = performance.now(); void b.play().catch(() => {}); }
        return;
      }
      const drift = b.currentTime - now;
      // the old one wrapped (a stand-in loops at 10 s) or the new one fell far behind: meet again
      if (Math.abs(drift) > 0.5) { arm(); return; }
      b.playbackRate = Math.min(1.25, Math.max(0.8, 1 - drift * 2));
      // a frame of its own near the old one's time; where the browser reports none for a covered video, playing in step
      // for a while is the proof
      const framed = presented >= 0 ? Math.abs(presented - now) < FRAME * 2 : !b.requestVideoFrameCallback || performance.now() - playedAt > 400;
      close = Math.abs(drift) < FRAME * 1.5 && framed ? close + 1 : 0;
      if (close >= 2) promote();
    };
    raf = requestAnimationFrame(tick);
    return () => { done = true; cancelAnimationFrame(raf); b.removeEventListener("seeked", onSeeked); };
  }, [next]);

  return (
    <>
      {next && <Layer key={next.src} src={next.src} shown={false} vref={(v) => { inc.current = v; }}
        onError={() => { setNext(null); if (!next.real) onError?.(); }} />}
      <Layer key={shownSrc} src={shownSrc} shown vref={(v) => { cur.current = v; }} onError={onError} onFrame={() => setCurReady(true)} />
    </>
  );
}
