import { Download, Library as LibraryIcon, Play } from "lucide-react";
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

// "Download without subscribing" and its "& apply", the right-click menu of the Browse sidebar's download / subscribe buttons
// (BrowseSide.tsx): a one-off copy into the library (POST /download {oneOff}), never a subscription, so nothing updates it.
// `missing` (GET /workshop/one-off: no way to fetch it here) = both entries disabled; the menu's note says what's missing.
// Guard: probe-steam side:oneOff:menu, side:oneOff:missing
export const oneOffMenuItems = (onPick: (apply: boolean) => void, missing: string | null): MenuItem[] => [
  { key: "oneoff", label: "Download without subscribing", icon: <Download size={14} />, onPick: () => onPick(false), disabled: !!missing },
  { key: "oneoff-apply", label: "Download without subscribing & apply", icon: <Play size={14} />, onPick: () => onPick(true), disabled: !!missing },
];
