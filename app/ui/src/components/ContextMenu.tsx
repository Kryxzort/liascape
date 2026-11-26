import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode, type SyntheticEvent } from "react";
import { createPortal } from "react-dom";
import { useLinger } from "../hooks/useLinger";
import { useMotion } from "./motion";

// `disabled`: shown but inert (aria-disabled, still focusable so the keys reach it and the menu's `note` says why)
export interface MenuItem { key: string; label: string; icon?: ReactNode; onPick: () => void; disabled?: boolean }
export type MenuAt = { x: number; y: number };

// how long a closing menu stays mounted for its exit (index.css `ctx-out`)
const CTX_OUT_MS = 130;
// the keys a light menu keeps (the rest close it and reach the page); a modifier alone is neither
// PERF: the window's size, read at start and on each resize, never while a menu opens (innerWidth / innerHeight force a layout
// right after the right-click's DOM changes). Guard: probe-layout perf:sidebar
const viewport = { w: innerWidth, h: innerHeight };
addEventListener("resize", () => { viewport.w = innerWidth; viewport.h = innerHeight; });
const MENU_KEYS = new Set(["ArrowDown", "ArrowUp", "Enter", " ", "Escape", "Tab", "Shift", "Control", "Alt", "Meta"]);

// A right-click menu, opened at the pointer: a control's own (a variant of its action), and a card's (components/menuItems.tsx
// cardMenuItems: Unsubscribe, Hide / Unhide; the right-click opens the item sidebar too).
// The dropdowns' look and layer (.sel-backdrop / .sel-pop / .sel-opt, z 90 / 91; `.sel-pop` also tells gridOwnsKey a menu
// owns the keys). It opens away from the window's nearer edges (no measuring: the side of the window the pointer is on) and
// grows out of that corner; the exit stays mounted (useLinger). Motion off: a fade in place. Keys: the first entry takes (a frame after it shows)
// focus, ↑ ↓ move, Escape / Tab close and hand focus back to `returnTo`. Portal'd to <body>, its events stopped in a
// `display: contents` wrapper: React bubbles a portal's events through the tree it was declared in. `note`: a line of plain
// text under the entries (why they are disabled), the menu's description; a click on a disabled entry keeps the menu open.
// `light` (a card's menu): the right-click that opens it also opens the item sidebar, which stays the page's to use. So no
// backdrop: a press or right-click anywhere else closes it and still does its own thing (another card's right-click opens that
// card's menu, a sidebar control works); a key the menu doesn't use (not ↑ ↓ Enter Space Escape Tab) closes it and goes on to
// the page; gridKeys.ts gridOwnsKey doesn't count it (`data-ctx-light`). It stays through the scroll that keeps its card under
// the pointer while the docked sidebar re-fits the grid (gridKeys.ts keepCardInView).
// Guard: probe-steam steam:subToggle:keepMenu, steam:subToggle:keepMenuOff, side:oneOff:menu, side:oneOff:missing,
// probe-hidden menu:lib, menu:browse, menu:through
export function ContextMenu({ at, items, onClose, returnTo, label, note, light = false }: {
  at: MenuAt | null; items: MenuItem[]; onClose: () => void; returnTo?: { readonly current: HTMLElement | null }; label: string;
  note?: string | null; light?: boolean;
}) {
  const motion = useMotion();
  const noteId = useId();
  const shown = useLinger(at, CTX_OUT_MS, motion);
  const pop = useRef<HTMLDivElement>(null);
  const open = at != null;

  useEffect(() => {
    if (!open) return;
    // PERF: the first entry takes focus a frame after the menu is drawn: focus() lays out the page, and right after the right-click
    // (the sidebar and the menu just mounted) that is a forced layout inside the click. Guard: probe-layout perf:sidebar
    let raf = requestAnimationFrame(() => { raf = requestAnimationFrame(() => pop.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true })); });
    // a fixed menu would drift from its control on a scroll or a resize: close it, like the dropdowns
    const close = () => onClose();
    const onScroll = (e: Event) => { if (!light && !pop.current?.contains(e.target as Node)) onClose(); };
    const outside = (e: Event) => { if (!pop.current?.contains(e.target as Node)) onClose(); };
    addEventListener("resize", close);
    addEventListener("scroll", onScroll, true);
    addEventListener("blur", close);
    if (light) { addEventListener("pointerdown", outside, true); addEventListener("contextmenu", outside, true); }
    return () => {
      cancelAnimationFrame(raf);
      removeEventListener("resize", close); removeEventListener("scroll", onScroll, true); removeEventListener("blur", close);
      removeEventListener("pointerdown", outside, true); removeEventListener("contextmenu", outside, true);
    };
  }, [open, onClose, light]);

  if (!shown.value) return null;
  const { x, y } = shown.value;
  const { w, h } = viewport;
  const left = x < w / 2, down = y < h * 0.6;
  const place = { [left ? "left" : "right"]: left ? x : w - x, [down ? "top" : "bottom"]: down ? y : h - y,
    transformOrigin: `${left ? "left" : "right"} ${down ? "top" : "bottom"}` };
  const dismiss = (back: boolean) => { onClose(); if (back) returnTo?.current?.focus({ preventScroll: true }); };
  const onKey = (e: KeyboardEvent) => {
    if (light && !MENU_KEYS.has(e.key)) { onClose(); return; } // the page's key: the menu goes, the key goes on
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
    <div style={{ display: "contents" }} onClick={stop} onPointerDown={stop} onContextMenu={(e) => { e.preventDefault(); stop(e); }} onKeyDown={onKey}>
      {!shown.closing && !light && <div className="sel-backdrop" onClick={() => dismiss(false)} onContextMenu={(e) => { e.preventDefault(); dismiss(false); }} />}
      <div ref={pop} className={`sel-pop ctx-pop${shown.closing ? " closing" : ""}`} role="menu" aria-label={label} style={place} data-ctx-menu
        data-ctx-light={light || undefined} aria-describedby={note ? noteId : undefined}>
        {items.map((it) => (
          <button key={it.key} type="button" role="menuitem" className="sel-opt ctx-opt" data-ctx-item={it.key}
            aria-disabled={it.disabled || undefined} disabled={shown.closing}
            onClick={() => { if (it.disabled) return; dismiss(true); it.onPick(); }}>
            {it.icon}{it.label}
          </button>
        ))}
        {note && <p id={noteId} className="ctx-note" data-ctx-note>{note}</p>}
      </div>
    </div>, document.body);
}
