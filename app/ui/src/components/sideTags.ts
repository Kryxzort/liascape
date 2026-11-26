import { WF_GROUPS } from "./workshopFilter";

// The tags the item sidebar lists in its About section (components/ItemSide.tsx): Steam's Workshop tags minus what says nothing here.
//   - "Wallpaper": the Workshop's top-level category, which says nothing about one item. "Preset" (Steam's type tag for a
//     preset, beside its base's type) still shows: next to the SCENE chip it is what says the item is a preset. The types
//     "Web" / "Application" still show too, for when those can play.
//   - "Video" / "Scene": the type (a scene already has its SCENE chip).
//   - every tag of a group a pill this sidebar SHOWS already tells: the resolution pill ("320 × 180") makes "Standard
//     Definition" and "1920 x 1080" alike a repeat, the age pill the age tags. Only the pills it shows, so a fact never
//     vanishes (an item without an age pill keeps its age tag).
// Guard: probe-sidebar look:sideTags (the hidden ones never listed).
const NEVER = new Set(["wallpaper", "video", "scene"]);
const groupTags = (id: string) => new Set(WF_GROUPS.find((g) => g.id === id)?.subs.flatMap((s) => s.tags.map((t) => t.tag.toLowerCase())) ?? []);
const RESOLUTION = groupTags("resolution"), AGE = groupTags("age");

// the age rating a result's tags carry (a Workshop result's is a tag; the sidebar shows it as a pill, as for a library item)
export function ageOf(tags: string[] | undefined | null): string | null {
  return tags?.find((t) => AGE.has(t.toLowerCase())) ?? null;
}

export function sideTags(tags: string[] | undefined | null, pills: { resolution?: boolean; age?: boolean }, max = 12): string[] {
  if (!tags?.length) return [];
  return tags.filter((t) => {
    const k = t.toLowerCase();
    return !NEVER.has(k) && !(pills.resolution && RESOLUTION.has(k)) && !(pills.age && AGE.has(k));
  }).slice(0, max);
}
