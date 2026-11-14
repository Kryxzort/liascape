import { Library as LibraryIcon } from "lucide-react";
import type { MenuAt, MenuItem } from "./ContextMenu";

// where a control's own menu (components/ContextMenu.tsx) opens: at the pointer, or under the control for the context-menu
// key (no pointer position)
export function menuAt(e: { clientX: number; clientY: number; currentTarget: Element }): MenuAt {
  if (e.clientX || e.clientY) return { x: e.clientX, y: e.clientY };
  const r = e.currentTarget.getBoundingClientRect();
  return { x: r.left, y: r.bottom };
}

// Unsubscribe's one variant, the same entry on the Browse sidebar's Unsubscribe (SubToggle.tsx) and the Library sidebar's
// (LibrarySide.tsx): unsubscribe and keep the library's copy (POST /workshop/unsubscribe-keep)
export const keepMenuItem = (onPick: () => void): MenuItem =>
  ({ key: "keep", label: "Unsubscribe without deleting", icon: <LibraryIcon size={14} />, onPick });
