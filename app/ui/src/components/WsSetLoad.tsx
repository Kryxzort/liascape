import { useEffect, useRef } from "react";
import { favoritesRowOn, useStore, type FavScope } from "../store";
import { useLinger } from "../hooks/useLinger";
import { useMotion } from "./motion";

// The favourites' load line at the top of Browse's grid (and of the Library's, which shows its whole list meanwhile: Library.tsx),
// while a Favourites row is ✓ / ✕ there and the list isn't all in: "Loading your favourites…" before anything has come, "Loading your favourites — 120 so far" while Steam hasn't said how
// many there are, "Loading your favourites — 120 of 450" once it has, with a thin bar under the words easing to the count (the
// library line's look: index.css .libops). A first Favourites ✓ on a big or private list never sits blank: the line shows from
// the click. While loading it floats over the grid's top, passing every click to the card under it (index.css
// .ws-set-load-dock: no room of its own), so its coming and going move no card. Steam unreachable is no passing state: its
// words and Retry (the load again, sync=open) take their own room above the grid and the cards glide down under them, so
// nothing covers a card while the error stays; what loaded stays in the grid.
// Guard: probe-steam yours:loadLine, yours:loadLineOff, yours:loadError, lib:yours:load, lib:yours:error

// the leave: the bar fills out to its end, then the line fades (index.css .ws-set-load.closing)
const LEAVE_MS = 450;
// the grid's glide when the error's room comes or goes (the sidebar's open: 220 ms ease-out)
const GLIDE_MS = 240;

type Line = { kind: "load"; done: number; total: number | null } | { kind: "error"; text: string };

const words = (l: Line) => (l.kind === "error" ? l.text
  : !l.done ? "Loading your favourites…"
  : l.total != null ? `Loading your favourites — ${l.done} of ${l.total}` : `Loading your favourites — ${l.done} so far`);

export function WsSetLoad({ scope = "workshop" }: { scope?: FavScope }) {
  const used = useStore((s) => favoritesRowOn(s, scope));
  // a string, not an object: useLinger follows identity, and every read of the favourites is a new object
  const key = useStore((s) => {
    if (!favoritesRowOn(s, scope)) return null;
    const f = s.wsFavs;
    const l: Line | null = !f ? { kind: "load", done: 0, total: null } : !f.signedIn ? null : f.error ? { kind: "error", text: f.error }
      : f.loading ? { kind: "load", done: f.loading.done, total: f.loading.total } : null;
    return l && JSON.stringify(l);
  });
  const active = useStore((s) => s.appActive);
  const loadFavorites = useStore((s) => s.loadFavorites);
  const motion = useMotion();
  const { value, closing } = useLinger(key, LEAVE_MS, motion);
  // COOL: the error's room comes and goes as a glide of what's under it (a FLIP on the grid and the empty-set message): the
  // dock's height change, read in a ResizeObserver callback (after layout, nothing forced), less what the browser's scroll
  // anchoring took up by scrolling, is played back from the old place on transform. Motion off: at once.
  // Guard: probe-steam yours:loadError, yours:loadLineOff
  const dock = useRef<HTMLDivElement>(null);
  const glide = useRef(motion);
  useEffect(() => { glide.current = motion; }, [motion]);
  useEffect(() => {
    const d = dock.current, sc = d?.parentElement;
    if (!d || !sc) return;
    // an empty dock is no box (index.css .ws-set-load-dock:empty): its height is 0 from the start, so a line that first
    // shows as an error (one already read, the row then turned on) glides from there, whether or not the engine reports
    // a hidden box's first size (Chromium does, as 0). Reading it would force a layout in the mount. Guard: probe-steam
    // yours:errorFirst
    let h0: number | null = d.firstElementChild ? null : 0, top0 = 0;
    const onScroll = () => { top0 = sc.scrollTop; };
    const ro = new ResizeObserver(([e]) => {
      const h = e.borderBoxSize?.[0]?.blockSize ?? e.contentRect.height, top = sc.scrollTop;
      const shift = h0 === null ? 0 : h - h0 - (top - top0);
      if (glide.current && Math.abs(shift) >= 1)
        for (let el = d.nextElementSibling; el; el = el.nextElementSibling)
          if (el.matches(".grid, .wf-none")) el.animate([{ transform: `translateY(${-shift}px)` }, { transform: "none" }], { duration: GLIDE_MS, easing: "cubic-bezier(.25, .8, .25, 1)" });
      h0 = h; top0 = top;
    });
    ro.observe(d);
    sc.addEventListener("scroll", onScroll, { passive: true });
    return () => { ro.disconnect(); sc.removeEventListener("scroll", onScroll); };
  }, []);
  // the dock stays while Browse shows the Workshop, empty without a line: its height is what the glide follows
  if (!value) return <div className="ws-set-load-dock" ref={dock} />;
  const l = JSON.parse(value) as Line;
  // gone because no Favourites row needs the list any more: it only fades, the bar stays where it was
  const away = closing && !used;
  const known = l.kind === "load" && l.total != null && l.total > 0;
  const frac = closing && !away ? 1 : known ? Math.min(1, l.done / l.total!) : 0;
  // COOL: it rises in and fades in; the bar eases to each count while a highlight sweeps along it (a sweep over the track
  // while the total isn't known); at the end the bar runs out to the edge, then the line fades and lifts away. Motion off:
  // it fades in and out in place and the bar steps (index.css § the favourites' load line)
  return (
    <div className={`ws-set-load-dock${l.kind === "error" ? " flow" : ""}`} ref={dock}>
      <div className={`ws-set-load${closing ? " closing" : ""}${away ? " away" : ""}${active ? "" : " idle"}`} data-ws-set-load={l.kind}
        role={l.kind === "error" ? "alert" : "status"}>
        {/* keyed by kind: the words of a load and of an error cross-fade, a count steps in place */}
        <span key={l.kind} className="wsl-text">{words(l)}</span>
        {l.kind === "error"
          ? <button type="button" className="btn ghost wsl-retry" data-wsl-retry disabled={closing} onClick={() => loadFavorites("open")}>Retry</button>
          : (
            <span className="wsl-track" aria-hidden>
              <span className="wsl-fill" style={{ transform: `scaleX(${frac})` }} />
              {!known && !closing && <span className="wsl-sweep" />}
            </span>
          )}
      </div>
    </div>
  );
}
