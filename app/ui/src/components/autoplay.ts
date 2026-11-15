import { useEffect, useState, type RefObject } from "react";

// Settings → Look & feel → "Not hovered" reaching "video" for an item (components/mediaAssets.ts usePreviewKinds): a library
// card / playlist-bar item plays its video without a hover (components/MotionThumb.tsx; a hover hands it over to the real
// file). Every such item ON SCREEN plays, no cap; what keeps it bounded is that nothing else does:
//   - only an item on screen plays (one shared IntersectionObserver; scrolled away, or its page hidden behind another
//     tab, = the <video> unmounts and its decoder goes),
//   - none while the window is backgrounded or unfocused (`appActive`: mediaAssets.ts useIdleOrder reaches only "image" then).
// Each plays a clip sized to its card (components/clipSource.ts), not the wallpaper's file, but still has a decoder of its
// own: the cost grows with how many are on screen and with "Video preview quality". Guard: matrix appear:videoThumbs.
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

// true while this element should play its video preview. `want`: unhovered, the item shows its video and nothing else
// already plays it (not being dragged).
export function useAutoplayVideo(ref: RefObject<Element | null>, want: boolean): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!want || !el) return;
    observe(el, setVisible);
    return () => { unobserve(el); setVisible(false); };
  }, [want, ref]);
  return want && visible;
}
