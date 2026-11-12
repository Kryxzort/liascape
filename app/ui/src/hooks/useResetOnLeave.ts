import { useLayoutEffect, type RefObject } from "react";
import { useStableFn } from "./useStableFn";

// App.tsx keeps a page mounted while another tab shows (hidden by React's <Activity>), so its state outlives a switch.
// Leaving it runs `reset` (clearing what a page built anew starts without, like a selection) and puts its grid back at its
// top, where a fresh page opens. The scroll is written only when it moved since the page showed: the write lays the page
// out, and the browser would otherwise bring the old position back with the page. A layout effect's cleanup: React runs it
// on hiding, while the page is still laid out. Guard: probe-layout tabs:keep
export function useResetOnLeave(scrollRef: RefObject<HTMLElement | null>, reset: () => void) {
  const onLeave = useStableFn(reset);
  useLayoutEffect(() => {
    let scrolled: HTMLElement | null = null;
    // scroll events don't bubble: caught on the way down, any element's
    const onScroll = (e: Event) => { if (e.target === scrollRef.current) scrolled = scrollRef.current; };
    addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => {
      removeEventListener("scroll", onScroll, { capture: true });
      if (scrolled) scrolled.scrollTop = 0;
      onLeave();
    };
  }, [scrollRef, onLeave]);
}
