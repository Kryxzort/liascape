import { SlidersHorizontal } from "lucide-react";

// A scene's type tag, on a card (`.badge`) or in a sidebar's hero line (`.side-chip`): SCENE, or PRESET in the same tag
// made hollow (index.css `.preset`: a dark fill, the accent as its ring and letters) and led by the presets' glyph (the
// Workshop's "Presets" row, WorkshopSocial.tsx), so the two tell apart by fill and shape even at small size.
// Guard: probe-sidebar lib:preset:badge, probe-filters filter:preset:badge
export function TypeBadge({ preset, chip = false }: { preset?: boolean; chip?: boolean }) {
  const base = chip ? "side-chip accent" : "badge";
  return preset
    ? <span className={`${base} preset`}><SlidersHorizontal aria-hidden="true" strokeWidth={2.75} />PRESET</span>
    : <span className={base}>SCENE</span>;
}
