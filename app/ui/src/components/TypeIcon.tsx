import { Box, SlidersHorizontal, type LucideIcon } from "lucide-react";

// A wallpaper's type as a small glyph: the cube for a scene, the presets' sliders for a preset (the Workshop's "Presets" row,
// WorkshopSocial.tsx), nothing for a video, the default. On a card it's a bare icon in the picture's top-left corner
// (`.type-ico`: light strokes on a dark shadow, so it reads on any picture), its type's name the tooltip and the label; in
// the item sidebar's hero line the same icon leads a chip with the name in words. A preset is a scene for everything else
// (greying, "Play scenes" off); only this tells them apart.
// Guard: probe-sidebar lib:type:icon, probe-filters filter:type:icon
const KINDS: Record<"scene" | "preset", { label: string; Icon: LucideIcon }> = {
  scene: { label: "Scene", Icon: Box },
  preset: { label: "Preset", Icon: SlidersHorizontal },
};

export function TypeIcon({ scene, preset, chip = false }: { scene: boolean; preset?: boolean; chip?: boolean }) {
  if (!scene) return null;
  const kind = preset ? "preset" : "scene", { label, Icon } = KINDS[kind];
  return chip
    ? <span className="side-chip accent" data-side-type={kind}><Icon size={12} aria-hidden="true" />{label}</span>
    : <span className="type-ico" data-type={kind} role="img" aria-label={label} title={label}><Icon aria-hidden="true" strokeWidth={2.5} /></span>;
}
