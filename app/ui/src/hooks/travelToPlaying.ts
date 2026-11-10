import { useEffect, type RefObject } from "react";

// "Travel to running wallpaper on app open" (owner todo, 2026-11-10): the first time a list shows the playing item in this
// app session — the app opening on Library, or the first visit to the Library tab with something playing — its scroll
// container jumps (no smooth glide: it's where the page opens) so the playing item sits in the middle of the view. Once
// per session per list (`key`): coming back to the tab later, or a switch while the app is open, never moves the user's
// scroll. Nothing playing / the item not in the list (a search hides it) → nothing happens, and the next chance tries again.
// `selector` finds the playing element inside `ref` (`.card.playing`, `.pl-item.playing`). The grid's cards are
// `content-visibility: auto` (their offscreen size is the intrinsic estimate), so the jump is re-aimed over a few frames
// while the cards around the target render at their real size.
const traveled = new Set<string>();

export function useTravelToPlaying(ref: RefObject<HTMLElement | null>, key: string, axis: "x" | "y", selector: string,
  playingPath: string | null, count: number) {
  useEffect(() => {
    if (traveled.has(key) || !playingPath || count === 0) return;
    let raf = 0, tries = 0, cancelled = false;
    const aim = () => {
      const sc = ref.current, el = sc?.querySelector<HTMLElement>(selector);
      if (!sc || !el || cancelled) return false;
      const s = sc.getBoundingClientRect(), r = el.getBoundingClientRect();
      if (s.width === 0 || s.height === 0) return false; // not laid out yet
      if (axis === "y") sc.scrollTop += r.top - s.top - (s.height - r.height) / 2;
      else sc.scrollLeft += r.left - s.left - (s.width - r.width) / 2;
      return true;
    };
    let aimed = 0;
    const step = () => {
      if (cancelled) return;
      if (aim()) { traveled.add(key); aimed++; }
      // the first aim → 3 more frames re-aimed (the cards near the target take their real size); not found yet → keep
      // looking for ~1 s (the list renders after the items land)
      if (aimed < 4 && ++tries < 60) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    // the user scrolling first wins: stop aiming
    const sc = ref.current;
    const stop = () => { cancelled = true; cancelAnimationFrame(raf); };
    sc?.addEventListener("wheel", stop, { passive: true });
    sc?.addEventListener("pointerdown", stop);
    return () => { stop(); sc?.removeEventListener("wheel", stop); sc?.removeEventListener("pointerdown", stop); };
  }, [playingPath, count]); // eslint-disable-line
}
