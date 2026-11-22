import { steamPageUrl, type LibraryItem, type Wallpaper, type WorkshopFilter, type WsList } from "../api/client";
import type { Opt } from "../components/Select";
import { facetsOf } from "../components/facets";
import { inLibrary } from "./libraryMatch";

// The filter column's Yours rows on the Workshop as sets the page already holds: "In my library" = the library's Workshop items, "Favourites" = the signed-in account's Workshop favourites
// (store wsFavs). A ✓ on either row shows that set directly — both ✓ the intersection, a ✓ and a ✕ the difference — with the
// other switches, the search and a sort of its own applied here, and no request to Steam; ✕ alone keeps the Workshop's paged
// query and hides the set's items from it. Imports nothing from the store or workshopFilter.ts: the store imports this.

// UI-only pseudo-tags in the include / exclude sets, never sent (store wireFilter strips every "@" tag)
export const LIBRARY_TAG = "@library";
export const FAVORITES_TAG = "@favorites";
// the Library's own "Crashed" row (items whose scene crashed the player: LibraryItem.hasCrashed), matched in views/Library.tsx
export const CRASHED_TAG = "@crashed";

export type SetMode = "inc" | "exc" | null;
export type SetModes = { lib: SetMode; fav: SetMode };
const modeOf = (f: WorkshopFilter, tag: string): SetMode => (f.include.includes(tag) ? "inc" : f.exclude.includes(tag) ? "exc" : null);
// signed out (or rejected by Steam) a saved Favourites ✓ / ✕ is kept but means nothing: Browse shows the Workshop as if it were –
export const setModesOf = (f: WorkshopFilter, favUsable: boolean): SetModes =>
  ({ lib: modeOf(f, LIBRARY_TAG), fav: favUsable ? modeOf(f, FAVORITES_TAG) : null });
export const isLocalSet = (m: SetModes) => m.lib === "inc" || m.fav === "inc";

// A local set's sorts: the fields the cached details hold. Never "Most Popular · period": Steam's trend ranking comes from
// activity the page can't see. Date Added is the library's own date, so only with In my library ✓.
export type LocalSort = "mostrecent" | "lastupdated" | "totaluniquesubscribers" | "toprated" | "mostfavorited" | "title" | "added";
const LOCAL_SORTS: [LocalSort, string][] = [
  ["mostrecent", "Most Recent"], ["lastupdated", "Recently Updated"], ["totaluniquesubscribers", "Most Subscribed"], ["toprated", "Top Rated"],
  ["mostfavorited", "Most Favourited"], ["title", "Title A–Z"], ["added", "Date Added"],
];
export const DEFAULT_LOCAL_SORT: LocalSort = "totaluniquesubscribers";
export const isLocalSort = (v: unknown): v is LocalSort => LOCAL_SORTS.some(([s]) => s === v);
const OPTS = LOCAL_SORTS.map(([value, label]) => ({ value, label }));
const OPTS_NO_ADDED = OPTS.filter((o) => o.value !== "added");
// stable arrays: the top bar's sort menu compares them by identity
export const localSortOptions = (libInc: boolean): Opt[] => (libInc ? OPTS : OPTS_NO_ADDED);
export const effectiveLocalSort = (saved: LocalSort, libInc: boolean): LocalSort => (saved === "added" && !libInc ? DEFAULT_LOCAL_SORT : saved);

// PERF: one card per library item object (a library re-read keeps unchanged objects: store keepSame), so the memo'd cards
// and their cached facets hold across renders
const libCardCache = new WeakMap<LibraryItem, Wallpaper>();
// A card built from the library's own data, for an item Steam has nothing on (removed, hidden, not fetched yet): the sorts'
// fields it lacks put it after the items that have them, and the tag switches read the library's tags
function libCard(i: LibraryItem, id: string): Wallpaper {
  let w = libCardCache.get(i);
  if (w) return w;
  w = {
    title: i.title, thumbnailUrl: i.thumbnailPath ?? "", animatedThumbnailUrl: i.animatedThumbnailPath, pageUrl: steamPageUrl(id),
    resolution: i.resolution, isScene: i.isScene, isPreset: !!i.isPreset, workshopId: id, ageRating: i.ageRating, tags: i.tags,
    children: i.isPreset && i.baseWorkshopId ? [i.baseWorkshopId] : null,
    addedAt: null, description: null, authorName: null, fileSizeBytes: null, subscriptions: null, favorites: null,
  };
  libCardCache.set(i, w);
  return w;
}
// The library's Workshop items as Browse cards: each from its cached Workshop details (store wsLibDetails), else from the
// library itself; one card per Workshop id. Guard: probe-steam yours:combos, yours:sort
export function libraryCards(items: LibraryItem[], details: Record<string, Wallpaper>): Wallpaper[] {
  const out: Wallpaper[] = [], seen = new Set<string>();
  for (const i of items) {
    const id = i.workshopId;
    if (!id || !/^\d+$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(details[id] ?? libCard(i, id));
  }
  return out;
}

type SortKey = (w: Wallpaper) => number | null;
const time = (s: string | null | undefined) => { const t = s ? Date.parse(s) : NaN; return Number.isFinite(t) ? t : null; };
const num = (n: number | null | undefined) => (typeof n === "number" && Number.isFinite(n) ? n : null);
const byTitle = (a: Wallpaper, b: Wallpaper) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" });

// The local set (Workshop ids): the sets' algebra, then the list it's shown in (a creator's: the details' creator; a scene's
// presets: a preset naming it as its base), scenes and presets as the Workshop lists them (a scene only with scene support;
// a preset only while presets can play and, outside a presets list, with Type's Preset ticked), the filter's tags, the
// search (every word in the title, the author's name or a tag, any case), then the sort: highest first, an item without the
// field after the rest, ties by title.
// Guard: probe-steam yours:*
export function buildLocalSet(a: {
  modes: SetModes; favs: Wallpaper[]; lib: Wallpaper[]; libAdded: Map<string, number>; list: WsList; query: string;
  match: ((facets: Set<string>) => boolean) | null; scenesOn: boolean; presetsOn: boolean; presetTicked: boolean; sort: LocalSort;
}): Wallpaper[] {
  const { modes } = a;
  const ids = (xs: Wallpaper[]) => new Set(xs.map((w) => w.workshopId));
  const favIds = ids(a.favs), libIds = ids(a.lib);
  const other = (set: Set<string | null>, m: SetMode) => (w: Wallpaper) => (m === "inc" ? set.has(w.workshopId) : m === "exc" ? !set.has(w.workshopId) : true);
  let out = modes.fav === "inc" ? a.favs.filter(other(libIds, modes.lib)) : modes.lib === "inc" ? a.lib.filter(other(favIds, modes.fav)) : [];
  const terms = a.query.toLowerCase().split(/\s+/).filter(Boolean);
  out = out.filter((w) => {
    if (a.list?.kind === "creator" && w.authorId !== a.list.id) return false;
    if (a.list?.kind === "presets" && !w.children?.includes(a.list.id)) return false;
    if (w.isPreset ? !(a.presetsOn && (a.list?.kind === "presets" || a.presetTicked)) : w.isScene && !a.scenesOn) return false;
    if (a.match && !a.match(facetsOf(w, w.pageUrl))) return false;
    if (terms.length) {
      const hay = [w.title, w.authorName ?? "", ...(w.tags ?? [])].map((s) => s.toLowerCase());
      if (!terms.every((t) => hay.some((h) => h.includes(t)))) return false;
    }
    return true;
  });
  if (a.sort === "title") return out.sort(byTitle);
  const key: SortKey = a.sort === "mostrecent" ? (w) => time(w.createdAt) : a.sort === "lastupdated" ? (w) => time(w.addedAt)
    : a.sort === "toprated" ? (w) => num(w.score) : a.sort === "mostfavorited" ? (w) => num(w.favorites)
    : a.sort === "added" ? (w) => (w.workshopId ? a.libAdded.get(w.workshopId) ?? null : null) : (w) => num(w.subscriptions);
  // PERF: each key read once, not per comparison (a 2,000-item set re-sorts on every keystroke of the search)
  return out.map((w) => ({ w, k: key(w) })).sort((x, y) =>
    x.k == null && y.k == null ? byTitle(x.w, y.w) : x.k == null ? 1 : y.k == null ? -1 : y.k - x.k || byTitle(x.w, y.w)).map((x) => x.w);
}

// A Favourites row against a list of items (a Workshop page, the Library): ✓ keeps the favourites, ✕ the rest; an item with no
// Workshop id is never a favourite. Guard: probe-steam yours:combos, lib:yours:fav
export function byFavorites<T>(list: T[], mode: SetMode, favIds: Set<string>, idOf: (x: T) => string | null | undefined): T[] {
  if (mode === null) return list;
  return list.filter((x) => { const id = idOf(x); return (!!id && favIds.has(id)) === (mode === "inc"); });
}

// ✕ with no ✓: the Workshop's own pages (or a list's), the sets' items taken out. Guard: probe-steam yours:combos, yours:inList
export function hideSets(list: Wallpaper[], modes: SetModes, favIds: Set<string>, libKeys: Set<string>): Wallpaper[] {
  if (modes.fav !== "exc" && modes.lib !== "exc") return list;
  const rest = modes.fav === "exc" ? byFavorites(list, "exc", favIds, (w) => w.workshopId) : list;
  return modes.lib === "exc" ? rest.filter((w) => !inLibrary(libKeys, w)) : rest;
}
