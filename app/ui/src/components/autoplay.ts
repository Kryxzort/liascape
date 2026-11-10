import { useEffect, useState, type RefObject } from "react";
import { useStore } from "../store";

// Settings → Look & feel → "Play video previews": a library card / playlist-bar item whose only preview is its
// VIDEO (no gif/webp asset — MotionThumb's hover fallback) plays that video without a hover. The same <video> layer
// the hover uses; what keeps it cheap on a big library:
//   - only an item ON SCREEN asks for a slot (an IntersectionObserver on its box — scrolled away = released),
//   - at most AUTOPLAY_VIDEO_CAP videos hold a slot at once across the whole page (cards + playlist bar share it);
//     the rest keep their still and take a slot as one frees up, in the order they asked,
//   - none while the window is backgrounded (`appActive`) or a card-settings modal is open.
// A hovered item plays regardless (that is the hover preview, on top of the cap).
export const AUTOPLAY_VIDEO_CAP = 4;

type Entry = { grant: (on: boolean) => void };
const granted = new Set<Entry>();
const queue: Entry[] = [];
function request(e: Entry) {
  if (granted.size < AUTOPLAY_VIDEO_CAP) { granted.add(e); e.grant(true); } else queue.push(e);
}
function release(e: Entry) {
  const was = granted.delete(e);
  const i = queue.indexOf(e); if (i >= 0) queue.splice(i, 1);
  if (!was) return;
  while (granted.size < AUTOPLAY_VIDEO_CAP && queue.length) { const n = queue.shift()!; granted.add(n); n.grant(true); }
}

// true while this element holds a slot. `eligible`: the item has a video preview and nothing else already plays it
// (not being dragged).
export function useAutoplayVideo(ref: RefObject<Element | null>, eligible: boolean): boolean {
  const on = useStore((s) => !!s.settings?.autoPlayVideoThumbs && s.appActive);
  const [visible, setVisible] = useState(false);
  const [has, setHas] = useState(false);
  const want = on && eligible;
  useEffect(() => {
    const el = ref.current;
    if (!want || !el) return;
    const io = new IntersectionObserver((es) => setVisible(es[es.length - 1].isIntersecting));
    io.observe(el);
    return () => { io.disconnect(); setVisible(false); };
  }, [want, ref]);
  useEffect(() => {
    if (!want || !visible) return;
    const e: Entry = { grant: setHas };
    request(e);
    return () => { release(e); setHas(false); };
  }, [want, visible]);
  return want && visible && has;
}
