// What a local item knows, as the filter column's lower-cased tag names: shared by the local filters (workshopFilter.ts
// localMatcher) and the Workshop's local sets (views/localSet.ts). A module of its own, importing nothing: the store imports
// the local sets, and workshopFilter.ts imports the store.

// its tags (Steam's, saved at download, else its project.json's genres + the features the file declares — the backend's
// WorkshopTags.FromProject), its age rating, its type and its resolution
export type Facetable = { tags: string[] | null; isScene: boolean; isPreset?: boolean; ageRating?: string | null; resolution: string | null };
const IMAGE = /\.(png|jpe?g|webp|gif|bmp)$/i;
const RES = /^\s*(\d{3,5})\s*[x×]\s*(\d{3,5})\s*$/i;
// PERF: per item object, computed once — a library re-read keeps the objects whose content didn't change (store keepSame)
const facetCache = new WeakMap<object, Set<string>>();
export function facetsOf(x: Facetable, path: string): Set<string> {
  let f = facetCache.get(x);
  if (f) return f;
  f = new Set<string>();
  for (const t of x.tags ?? []) f.add(t.toLowerCase());
  if (x.ageRating) f.add(x.ageRating.toLowerCase());
  // an image (an imported still) is neither a Video nor a Scene; a preset is both a Preset and a Scene (it plays as one)
  if (x.isScene) f.add("scene"); else if (!IMAGE.test(path)) f.add("video");
  if (x.isPreset) f.add("preset");
  const r = x.resolution ? RES.exec(x.resolution) : null;
  if (r) f.add(`${r[1]} x ${r[2]}`);
  facetCache.set(x, f);
  return f;
}
