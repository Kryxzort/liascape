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

// "Go to the playing wallpaper" buttons (owner 2026-11-11: "a button in library and playlist bar that takes you to the current
// running wallpaper") — the Library top bar's and the playlist bar head's. `glideTo` eases the scroll container so `selector`'s
// element sits mid-view: every frame it re-measures where the element is (the grid's `content-visibility` cards take their real
// size as they come into view, so a target computed once would land off) and closes a fraction of the remaining distance
// (exponential, ~0.5 s), stopping when it's there, after 1.5 s, or the moment the user wheels / presses in the container.
// Motion off → one jump, re-aimed over 3 frames like the app-open travel. Then the element gets `.locate-flash` (a ring, 1 s).
// Returns false when the element isn't in the list (nothing playing, the item filtered out / not in the playlist).
export function glideTo(sc: HTMLElement | null, selector: string, axis: "x" | "y", smooth: boolean): boolean {
  if (!sc || !sc.querySelector(selector)) return false;
  const TAU = 110, MAX_MS = 1500;
  let raf = 0, last = 0, t0 = 0, frames = 0, stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true; cancelAnimationFrame(raf);
    sc.removeEventListener("wheel", stop); sc.removeEventListener("pointerdown", stop);
  };
  const flash = () => {
    const el = sc.querySelector<HTMLElement>(selector);
    if (!el) return;
    el.classList.remove("locate-flash"); void el.offsetWidth; // restart the ring if it's still on
    el.classList.add("locate-flash");
    setTimeout(() => el.classList.remove("locate-flash"), 1000);
  };
  const step = (t: number) => {
    if (stopped) return;
    const el = sc.querySelector<HTMLElement>(selector);
    if (!el) { stop(); return; }
    if (!t0) t0 = t;
    const s = sc.getBoundingClientRect(), r = el.getBoundingClientRect();
    const cur = axis === "y" ? sc.scrollTop : sc.scrollLeft;
    const delta = axis === "y" ? r.top - s.top - (s.height - r.height) / 2 : r.left - s.left - (s.width - r.width) / 2;
    const dt = last ? Math.min(t - last, 64) : 16;
    last = t;
    // the browser clamps at the list's ends (an item at the very end can't be centred): no own max — scrollWidth − clientWidth
    // came out 3 px short of the real end — just stop once a step no longer moves it
    const next = !smooth || Math.abs(delta) < 0.75 ? cur + delta : cur + delta * (1 - Math.exp(-dt / TAU));
    if (axis === "y") sc.scrollTop = next; else sc.scrollLeft = next;
    const moved = Math.abs((axis === "y" ? sc.scrollTop : sc.scrollLeft) - cur);
    frames++;
    const done = smooth ? Math.abs(delta) < 0.75 || (frames > 2 && moved < 0.25) : frames >= 4;
    if (done || t - t0 > MAX_MS) { stop(); flash(); return; }
    raf = requestAnimationFrame(step);
  };
  sc.addEventListener("wheel", stop, { passive: true });
  sc.addEventListener("pointerdown", stop);
  raf = requestAnimationFrame(step);
  return true;
}
