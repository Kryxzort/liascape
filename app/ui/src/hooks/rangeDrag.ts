// Keys while a slider is held (owner: "make F not do yellow outline when holding slider").
// A key pressed during a pointer drag on an <input type=range> did two things: Chromium switches to
// keyboard modality on any keydown, so the held (mouse-focused) slider started matching :focus-visible and
// got the system focus ring (the yellow outline — F only because that's the key that got pressed; nothing in
// the app is bound to F), and the app's own shortcuts (Delete trashes the library selection, Escape closes
// the modal, Ctrl+A selects all, arrows step the slider under the pointer) fired mid-drag.
// While a range drag is in progress every keydown/keyup is swallowed (capture phase on window, installed
// before any other listener — nothing else sees it), and a slider that got a key during its drag is blurred
// on release so it doesn't keep the keyboard-modality ring afterwards. CSS (index.css) replaces the system
// ring on range inputs with the accent glow, shown for keyboard focus only.

let dragging: HTMLInputElement | null = null;
let keyed = false;

const isRange = (t: EventTarget | null): t is HTMLInputElement =>
  t instanceof HTMLInputElement && t.type === "range";

/** a pointer drag on a slider is in progress (shortcut handlers bail while it is) */
export const rangeDragActive = () => dragging !== null;

/** don't hijack keys while typing in a field or holding a slider */
export function shortcutsBlocked(): boolean {
  if (dragging) return true;
  const a = document.activeElement as HTMLElement | null;
  return !!a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.isContentEditable);
}

let installed = false;
export function installRangeDragGuard() {
  if (installed) return;
  installed = true;
  const end = () => {
    const el = dragging;
    dragging = null;
    document.documentElement.classList.remove("range-dragging");
    if (el && keyed) el.blur();
    keyed = false;
  };
  addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !isRange(e.target) || e.target.disabled) return;
    dragging = e.target; keyed = false;
    document.documentElement.classList.add("range-dragging");
  }, true);
  addEventListener("pointerup", end, true);
  addEventListener("pointercancel", end, true);
  addEventListener("blur", end); // the window lost focus mid-drag: no pointerup will come
  const swallow = (e: KeyboardEvent) => {
    if (!dragging) return;
    keyed = true;
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  addEventListener("keydown", swallow, true);
  addEventListener("keyup", swallow, true);
}
