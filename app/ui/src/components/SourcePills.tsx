import { useEffect, useRef } from "react";
import { RefreshCw } from "lucide-react";
import { useStore } from "../store";
import { api } from "../api/client";
import { useSmoothScroll } from "../hooks/useSmoothScroll";
import { useMotion } from "./motion";

// Browse's source pills in the top bar. The top bar never wraps from 761 px up (docs/decisions.md § "Filter the Workshop in a
// column of three-way switches", its placement): when the pills don't fit beside the search and the split button, their
// strip scrolls sideways (the wheel too, useSmoothScroll), its clipped edge fading out (index.css `.pill-strip`), and the
// chosen pill is brought into view. Refresh stays outside the strip. Only sources: a Workshop list (a creator's, a scene's
// presets) is a filter, the column's Author / Presets of field (WorkshopListFields.tsx; .claude/rules/ui/design.md § Layout
// discipline), and the Workshop's pill stays lit under it. Guard: probe-filters split:noWrap:*, probe-layout resize:*,
// probe-steam list:noPills
export function SourcePills() {
  const sources = useStore((s) => s.sources);
  const active = useStore((s) => s.activeSource);
  const setSource = useStore((s) => s.setSource);
  const reload = useStore((s) => s.reload);
  const motion = useMotion();
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
          const into = (e: React.MouseEvent<HTMLElement>) => e.currentTarget.scrollIntoView({ inline: "nearest", block: "nearest", behavior: motion ? "smooth" : "instant" });
          // API: a Workshop pill hovered or focused: Steam's anonymous session connects ahead of its page (api.steamWarm).
          // Guard: probe-steam browse:warm
          const warm = x.supportsTagFilter ? { onPointerEnter: api.steamWarm, onFocus: api.steamWarm } : null;
          return (
            <button key={x.index} className={`pill${active === x.index ? " active" : ""}`}
              {...warm} onClick={(e) => { into(e); setSource(x.index); }}>{x.name}</button>
          );
        })}
      </div>
      <button className="mini" aria-label="Refresh" onClick={() => reload()}><RefreshCw size={16} /></button>
    </div>
  );
}
