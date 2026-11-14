import { useEffect, useRef, type KeyboardEvent, type ReactNode, type SyntheticEvent } from "react";
import { createPortal } from "react-dom";
import { useLinger } from "../hooks/useLinger";
import { useMotion } from "./motion";

export interface MenuItem { key: string; label: string; icon?: ReactNode; onPick: () => void }
export type MenuAt = { x: number; y: number };

// how long a closing menu stays mounted for its exit (index.css `ctx-out`)
const CTX_OUT_MS = 130;

// A control's own right-click menu (never an item's: a right-click on a card opens its sidebar), opened at the pointer.
// The dropdowns' look and layer (.sel-backdrop / .sel-pop / .sel-opt, z 90 / 91; `.sel-pop` also tells gridOwnsKey a menu
// owns the keys). It opens away from the window's nearer edges (no measuring: the side of the window the pointer is on) and
// grows out of that corner; the exit stays mounted (useLinger). Motion off: a fade in place. Keys: the first entry takes
// focus, ↑ ↓ move, Escape / Tab close and hand focus back to `returnTo`. Portal'd to <body>, its events stopped in a
// `display: contents` wrapper: React bubbles a portal's events through the tree it was declared in.
// Guard: probe-steam steam:subToggle:keepMenu, steam:subToggle:keepMenuOff
export function ContextMenu({ at, items, onClose, returnTo, label }: {
  at: MenuAt | null; items: MenuItem[]; onClose: () => void; returnTo?: { readonly current: HTMLElement | null }; label: string;
}) {
  const motion = useMotion();
  const shown = useLinger(at, CTX_OUT_MS, motion);
  const pop = useRef<HTMLDivElement>(null);
  const open = at != null;

  useEffect(() => {
    if (!open) return;
    pop.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
    // a fixed menu would drift from its control on a scroll or a resize: close it, like the dropdowns
    const close = () => onClose();
    const onScroll = (e: Event) => { if (!pop.current?.contains(e.target as Node)) onClose(); };
    addEventListener("resize", close);
    addEventListener("scroll", onScroll, true);
    addEventListener("blur", close);
    return () => { removeEventListener("resize", close); removeEventListener("scroll", onScroll, true); removeEventListener("blur", close); };
  }, [open, onClose]);

  if (!shown.value) return null;
  const { x, y } = shown.value;
  const left = x < innerWidth / 2, down = y < innerHeight * 0.6;
  const place = { [left ? "left" : "right"]: left ? x : innerWidth - x, [down ? "top" : "bottom"]: down ? y : innerHeight - y,
    transformOrigin: `${left ? "left" : "right"} ${down ? "top" : "bottom"}` };
  const dismiss = (back: boolean) => { onClose(); if (back) returnTo?.current?.focus({ preventScroll: true }); };
  const onKey = (e: KeyboardEvent) => {
    e.stopPropagation();
    const btns = [...(pop.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    const i = btns.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "Escape") { e.preventDefault(); dismiss(true); }
    else if (e.key === "Tab") { e.preventDefault(); dismiss(true); }
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      btns[(i + (e.key === "ArrowDown" ? 1 : -1) + btns.length) % btns.length]?.focus();
    }
  };
  const stop = (e: SyntheticEvent) => e.stopPropagation();
  return createPortal(
    <div style={{ display: "contents" }} onClick={stop} onPointerDown={stop} onContextMenu={stop} onKeyDown={onKey}>
      {!shown.closing && <div className="sel-backdrop" onClick={() => dismiss(false)} onContextMenu={(e) => { e.preventDefault(); dismiss(false); }} />}
      <div ref={pop} className={`sel-pop ctx-pop${shown.closing ? " closing" : ""}`} role="menu" aria-label={label} style={place} data-ctx-menu>
        {items.map((it) => (
          <button key={it.key} type="button" role="menuitem" className="sel-opt ctx-opt" data-ctx-item={it.key}
            disabled={shown.closing} onClick={() => { dismiss(true); it.onPick(); }}>
            {it.icon}{it.label}
          </button>
        ))}
      </div>
    </div>, document.body);
}
