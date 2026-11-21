import { useStore } from "../store";
import { useLinger } from "../hooks/useLinger";
import { useMotion } from "./motion";

// The favourites' load line at the top of Browse's grid, while a Favourites row is ✓ / ✕ on the Workshop and the list isn't all
// in: "Loading your favourites…" before anything has come, "Loading your favourites — 120 so far" while Steam hasn't said how
// many there are, "Loading your favourites — 120 of 450" once it has, with a thin bar under the words easing to the count (the
// library line's look: index.css .libops). Steam unreachable: its words and Retry (the load again, sync=open); what loaded
// stays in the grid. A first Favourites ✓ on a big or private list never sits blank: the line shows from the click. It floats
// over the grid's top (index.css .ws-set-load-dock: no room of its own), so neither its coming nor its going moves a card.
// Guard: probe-steam yours:loadLine, yours:loadLineOff, yours:loadError

// the leave: the bar fills out to its end, then the line fades (index.css .ws-set-load.closing)
const LEAVE_MS = 450;

type Line = { kind: "load"; done: number; total: number | null } | { kind: "error"; text: string };

const words = (l: Line) => (l.kind === "error" ? l.text
  : !l.done ? "Loading your favourites…"
  : l.total != null ? `Loading your favourites — ${l.done} of ${l.total}` : `Loading your favourites — ${l.done} so far`);

export function WsSetLoad() {
  const used = useStore((s) => s.isWorkshop() && s.setModes().fav !== null);
  // a string, not an object: useLinger follows identity, and every read of the favourites is a new object
  const key = useStore((s) => {
    if (!s.isWorkshop() || s.setModes().fav === null) return null;
    const f = s.wsFavs;
    const l: Line | null = !f ? { kind: "load", done: 0, total: null } : !f.signedIn ? null : f.error ? { kind: "error", text: f.error }
      : f.loading ? { kind: "load", done: f.loading.done, total: f.loading.total } : null;
    return l && JSON.stringify(l);
  });
  const active = useStore((s) => s.appActive);
  const loadFavorites = useStore((s) => s.loadFavorites);
  const motion = useMotion();
  const { value, closing } = useLinger(key, LEAVE_MS, motion);
  if (!value) return null;
  const l = JSON.parse(value) as Line;
  // gone because no Favourites row needs the list any more: it only fades, the bar stays where it was
  const away = closing && !used;
  const known = l.kind === "load" && l.total != null && l.total > 0;
  const frac = closing && !away ? 1 : known ? Math.min(1, l.done / l.total!) : 0;
  // COOL: it rises in and fades in; the bar eases to each count while a highlight sweeps along it (a sweep over the track
  // while the total isn't known); at the end the bar runs out to the edge, then the line fades and lifts away. Motion off:
  // it fades in and out in place and the bar steps (index.css § the favourites' load line)
  return (
    <div className="ws-set-load-dock">
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
