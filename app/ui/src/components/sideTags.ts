import { WF_GROUPS } from "./workshopFilter";

// The tags a sidebar lists under its pills (LibrarySide, BrowseSide): Steam's Workshop tags minus what says nothing here.
//   - "Wallpaper": the Workshop's top-level category, which says nothing about one item. "Preset" (Steam's type tag for a
//     preset, beside its base's type) still shows: next to the SCENE chip it is what says the item is a preset. The types
//     "Web" / "Application" still show too, for when those can play.
//   - "Video" / "Scene": the type (a scene already has its SCENE chip).
//   - every tag of a group a pill this sidebar SHOWS already tells: the resolution pill ("320 × 180") makes "Standard
//     Definition" and "1920 x 1080" alike a repeat, the age pill the age tags. Only the pills it shows, so a fact never
//     vanishes (Browse has no age pill: its age tag stays).
// Guard: probe-sidebar look:sideTags (the hidden ones never listed).
const NEVER = new Set(["wallpaper", "video", "scene"]);
const groupTags = (id: string) => new Set(WF_GROUPS.find((g) => g.id === id)?.subs.flatMap((s) => s.tags.map((t) => t.tag.toLowerCase())) ?? []);
const RESOLUTION = groupTags("resolution"), AGE = groupTags("age");

export function sideTags(tags: string[] | undefined | null, pills: { resolution?: boolean; age?: boolean }, max = 12): string[] {
  if (!tags?.length) return [];
  return tags.filter((t) => {
    const k = t.toLowerCase();
    return !NEVER.has(k) && !(pills.resolution && RESOLUTION.has(k)) && !(pills.age && AGE.has(k));
  }).slice(0, max);
}
