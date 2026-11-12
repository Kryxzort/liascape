// The tags a sidebar lists under its pills (LibrarySide, BrowseSide): Steam's Workshop tags minus what says nothing here.
//   - "Wallpaper": the Workshop's top-level category; its other value, "Preset", is dropped before anything reaches the app
//     (WorkshopTags.Unplayable), so every item carries it. "Preset" (and the types "Web" / "Application") still show, for
//     when those can play.
//   - "Video" / "Scene": the type (a scene already has its SCENE chip).
//   - a tag repeating a pill this sidebar shows (the resolution, the age rating): only the pills it SHOWS, so a fact
//     never vanishes (Browse has no age pill: its age tag stays).
// Guard: probe-sidebar look:sideRhythm (the hidden ones never listed).
const NEVER = new Set(["wallpaper", "video", "scene"]);
// "1920 × 1080" (the pill) and "1920 x 1080" (Steam's tag) are the same fact
const norm = (s: string) => s.toLowerCase().replace(/[×x]/g, "x").replace(/\s+/g, "");

export function sideTags(tags: string[] | undefined | null, pills: (string | null | undefined)[], max = 12): string[] {
  if (!tags?.length) return [];
  const shown = new Set(pills.filter((p): p is string => !!p).map(norm));
  return tags.filter((t) => !NEVER.has(t.toLowerCase()) && !shown.has(norm(t))).slice(0, max);
}
