import type { LibraryItem, Wallpaper } from "../api/client";
// "Mark the wallpapers already downloaded": what of a Browse list the library already holds — by
// its Workshop id (Workshop + the WE-local folder: the same item under either source), else by the page it came from
// (moewalls / motionbgs / desktophut downloads keep it as `pageUrl`; `sourceId` is the source URL too).
export function libraryKeys(items: LibraryItem[]): Set<string> {
  const k = new Set<string>();
  for (const i of items) {
    if (i.workshopId) k.add("ws:" + i.workshopId);
    for (const u of [i.pageUrl, i.sourceId, i.videoPath]) if (u) k.add("url:" + u);
  }
  return k;
}

export const inLibrary = (keys: Set<string>, w: Wallpaper) =>
  (!!w.workshopId && keys.has("ws:" + w.workshopId)) || keys.has("url:" + w.pageUrl);

// the library's copy of a Browse item (same rule as inLibrary) — the sidebar's Apply / Show in Library
export const libraryCopy = (items: LibraryItem[], w: Wallpaper) =>
  items.find((i) => (!!w.workshopId && i.workshopId === w.workshopId) || [i.pageUrl, i.sourceId, i.videoPath].includes(w.pageUrl)) ?? null;
