import { useEffect, useState, type RefObject } from "react";
import { useStore } from "../store";

// Settings → Look & feel → "Play video previews": a library card / playlist-bar item whose preview is a VIDEO
// (components/mediaAssets.ts previewVideo) plays it without a hover. The same <video> layer the hover uses. Every such
// item ON SCREEN plays, no cap; what keeps it bounded is that nothing else does:
//   - only an item on screen plays (one shared IntersectionObserver; scrolled away, or its page hidden behind another
//     tab, = the <video> unmounts and its decoder goes),
//   - none while the window is backgrounded or unfocused (`appActive`).
// Each plays a small clip, not the wallpaper's file (MotionThumb, the backend's /clip), but still has a decoder of its
// own: the cost grows with how many are on screen, and the Settings hint says so. Guard: matrix appear:videoThumbs.
type Seen = (on: boolean) => void;
const watchers = new Map<Element, Seen>();
let io: IntersectionObserver | null = null;
// PERF: one observer for every card and bar item, not one each: a scroll then computes one batch of intersections
function observe(el: Element, cb: Seen) {
  io ??= new IntersectionObserver((es) => { for (const e of es) watchers.get(e.target)?.(e.isIntersecting); });
  watchers.set(el, cb);
  io.observe(el);
}
function unobserve(el: Element) {
  watchers.delete(el);
  io?.unobserve(el);
}

// true while this element should play its video preview. `eligible`: the item has a video preview and nothing else
// already plays it (not being dragged).
export function useAutoplayVideo(ref: RefObject<Element | null>, eligible: boolean): boolean {
  const on = useStore((s) => !!s.settings?.autoPlayVideoThumbs && s.appActive);
  const [visible, setVisible] = useState(false);
  const want = on && eligible;
  useEffect(() => {
    const el = ref.current;
    if (!want || !el) return;
    observe(el, setVisible);
    return () => { unobserve(el); setVisible(false); };
  }, [want, ref]);
  return want && visible;
}
