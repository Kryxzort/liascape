import { useEffect, useRef } from "react";
import { RefreshCw, Star, X } from "lucide-react";
import { useStore } from "../store";
import { useSmoothScroll } from "../hooks/useSmoothScroll";
import { useLinger } from "../hooks/useLinger";
import { useMotion } from "./motion";
import { Avatar } from "./WorkshopSocial";

// Browse's source pills in the top bar. The top bar never wraps from 761 px up (docs/decisions.md § "Filter the Workshop in a
// column of three-way switches", its placement): when the pills don't fit beside the search and the split button, their
// strip scrolls sideways (the wheel too, useSmoothScroll), its clipped edge fading out (index.css `.pill-strip`), and the
// chosen pill is brought into view. Refresh stays outside the strip. Guard: probe-filters split:noWrap:*, probe-layout resize:*
export function SourcePills() {
  const sources = useStore((s) => s.sources);
  const active = useStore((s) => s.activeSource);
  const setSource = useStore((s) => s.setSource);
  const reload = useStore((s) => s.reload);
  const wsList = useStore((s) => s.wsList);
  const setWsList = useStore((s) => s.setWsList);
  const motion = useMotion();
  // a creator's pill (the Browse sidebar's creator row puts it here) stays for its exit
  const creator = useLinger(wsList?.kind === "creator" ? wsList : null, 170, motion);
  const ref = useRef<HTMLDivElement>(null);
  const smoothRef = useSmoothScroll(ref, "x");
  // which edges hide a pill (the fade): read from the strip's own scroll / resize callbacks, written to its attributes —
  // no render, no layout read outside them
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let first = true;
    const edges = () => {
      const max = el.scrollWidth - el.clientWidth;
      el.toggleAttribute("data-more-l", el.scrollLeft > 1);
      el.toggleAttribute("data-more-r", el.scrollLeft < max - 1);
    };
    const ro = new ResizeObserver(() => {
      // the page's first layout: the chosen pill in view (a later source is often past the strip's end)
      const a = el.querySelector<HTMLElement>(".pill.active");
      if (first && a) { first = false; if (a.offsetLeft + a.offsetWidth > el.clientWidth) el.scrollLeft = a.offsetLeft + a.offsetWidth - el.clientWidth; }
      edges();
    });
    ro.observe(el);
    el.addEventListener("scroll", edges, { passive: true });
    return () => { ro.disconnect(); el.removeEventListener("scroll", edges); };
  }, []);
  return (
    <div className="pills">
      <div className="pill-strip" ref={smoothRef}>
        {sources.filter((x) => x.available).map((x) => {
          const ws = x.supportsTagFilter && active === x.index;
          const into = (e: React.MouseEvent<HTMLElement>) => e.currentTarget.scrollIntoView({ inline: "nearest", block: "nearest", behavior: motion ? "smooth" : "instant" });
          return [
            <button key={x.index} className={`pill${active === x.index && !(ws && wsList) ? " active" : ""}`}
              onClick={(e) => { into(e); setSource(x.index); }}>{x.name}</button>,
            // the Workshop's lists, beside its pill (store wsList): the signed-in account's favourites, and the creator the
            // sidebar's creator row picked — its avatar + name, × back to the whole Workshop. Guard: probe-steam ws:pills
            x.supportsTagFilter && (
              <button key="ws-fav" className={`pill ico ws-pill${ws && wsList?.kind === "favorites" ? " active" : ""}`} data-ws-pill="favorites"
                onClick={(e) => { into(e); setWsList({ kind: "favorites" }); }}><Star size={14} /> Favourites</button>
            ),
            x.supportsTagFilter && creator.value && (
              <span key="ws-creator" className={`ws-pill-pair${creator.closing ? " closing" : ""}`} data-ws-pill="creator">
                <button className={`pill ico ws-pill${ws && wsList?.kind === "creator" ? " active" : ""}`}
                  onClick={(e) => { into(e); setWsList(creator.value); }}><Avatar src={creator.value.avatar} size={20} />{creator.value.name ?? "Creator"}</button>
                <button className="ws-pill-x" aria-label="Back to the whole Workshop" onClick={() => setSource(x.index)}><X size={12} /></button>
              </span>
            ),
          ];
        })}
      </div>
      <button className="mini" aria-label="Refresh" onClick={() => reload()}><RefreshCw size={16} /></button>
    </div>
  );
}
