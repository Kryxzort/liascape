import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronDown } from "lucide-react";
import { useSmoothScroll } from "../hooks/useSmoothScroll";

export interface Opt { value: string; label: string }

// App-controlled dropdown replacing native <select> — fully styleable + translucent (native popups are
// OS-rendered, can't be themed/translucent). Trade-off vs native: we own positioning, click-away and
// keyboard. The list is portal'd to <body> (position:fixed) so it escapes the bars'/cards' overflow +
// backdrop-filter containing blocks, with a transparent backdrop for click-away (matches .ctx-menu).
// `icon` leads the value (the top bar's sort, components/SortFilterButton.tsx); `align="right"` opens the list from the
// button's right edge (a control at the window's right edge: a list wider than it stays inside the window)
export function Select({ value, options, onChange, className = "", title, disabled, icon, align = "left", ariaLabel }: {
  value: string | number; options: Opt[]; onChange: (v: string) => void; className?: string; title?: string; disabled?: boolean;
  icon?: ReactNode; align?: "left" | "right"; ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<{ left: number; right: number; top: number; width: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const popSmooth = useSmoothScroll(pop); // momentum scroll inside the list, matching the rest of the app
  const cur = options.find((o) => String(o.value) === String(value));

  const place = () => { const r = btn.current?.getBoundingClientRect(); if (r) setRect({ left: r.left, right: innerWidth - r.right, top: r.bottom + 4, width: r.width }); };
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
      <button ref={btn} type="button" className={`sel${open ? " open" : ""} ${className}`} title={title} disabled={disabled}
        aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); if (disabled) return; if (open) { setOpen(false); return; } place(); setOpen(true); }}>
        {icon}
        <span className="sel-val">{cur?.label ?? ""}</span>
        <ChevronDown size={14} className="sel-caret" />
      </button>
      {open && rect && createPortal(
        <>
          <div className="sel-backdrop" onClick={() => setOpen(false)} onContextMenu={(e) => { e.preventDefault(); setOpen(false); }} />
          <div ref={popSmooth} className="sel-pop" style={align === "right" ? { right: rect.right, top: rect.top, minWidth: rect.width } : { left: rect.left, top: rect.top, minWidth: rect.width }}>
            {options.map((o) => (
              <button key={o.value} type="button" className={`sel-opt${String(o.value) === String(value) ? " on" : ""}`}
                onClick={() => { onChange(o.value); setOpen(false); }}>{o.label}</button>
            ))}
          </div>
        </>, document.body)}
    </>
  );
}
