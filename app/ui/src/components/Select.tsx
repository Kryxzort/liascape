import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown } from "lucide-react";
import { useSmoothScroll } from "../hooks/useSmoothScroll";

export interface Opt { value: string; label: string }

// App-controlled dropdown replacing native <select> — fully styleable + translucent (native popups are
// OS-rendered, can't be themed/translucent). Trade-off vs native: we own positioning, click-away and
// keyboard. The list is portal'd to <body> (position:fixed) so it escapes the bars'/cards' overflow +
// backdrop-filter containing blocks, with a transparent backdrop for click-away (matches .ctx-menu).
export function Select({ value, options, onChange, className = "", title }: {
  value: string | number; options: Opt[]; onChange: (v: string) => void; className?: string; title?: string;
}) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<{ left: number; top: number; width: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  useSmoothScroll(pop, "y", [open]); // momentum scroll inside the list, matching the rest of the app
  const cur = options.find((o) => String(o.value) === String(value));

  const place = () => { const r = btn.current?.getBoundingClientRect(); if (r) setRect({ left: r.left, top: r.bottom + 4, width: r.width }); };
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    // close on OUTSIDE scroll (list is position:fixed → would drift) — but NOT when scrolling the list itself
    const onScroll = (e: Event) => { if (!pop.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    addEventListener("resize", close);
    addEventListener("scroll", onScroll, true);
    addEventListener("keydown", onKey);
    return () => { removeEventListener("resize", close); removeEventListener("scroll", onScroll, true); removeEventListener("keydown", onKey); };
  }, [open]);

  return (
    <>
      <button ref={btn} type="button" className={`sel ${className}`} title={title}
        onClick={(e) => { e.stopPropagation(); if (open) { setOpen(false); return; } place(); setOpen(true); }}>
        <span className="sel-val">{cur?.label ?? ""}</span>
        <ChevronDown size={14} className="sel-caret" />
      </button>
      {open && rect && createPortal(
        <>
          <div className="sel-backdrop" onClick={() => setOpen(false)} onContextMenu={(e) => { e.preventDefault(); setOpen(false); }} />
          <div ref={pop} className="sel-pop" style={{ left: rect.left, top: rect.top, minWidth: rect.width }}>
            {options.map((o) => (
              <button key={o.value} type="button" className={`sel-opt${String(o.value) === String(value) ? " on" : ""}`}
                onClick={() => { onChange(o.value); setOpen(false); }}>{o.label}</button>
            ))}
          </div>
        </>, document.body)}
    </>
  );
}
