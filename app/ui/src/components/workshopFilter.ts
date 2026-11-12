import { useCallback, useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react";
import { WF_DOCK_QUERY, filterOf, useStore, type FilterPage, type FilterScope, type TagState } from "../store";
import type { WorkshopFilter } from "../api/client";
import { useMotion } from "./motion";
import { SIDE_CLOSE_MS, useLinger } from "../hooks/useLinger";
import { keepCardInView } from "../hooks/gridKeys";

// The Workshop filter column's data + hooks (components/WorkshopFilterColumn.tsx) — a module of its own so the component file
// exports components only (fast refresh).

// Steam's tag taxonomy (the requiredtags the backend sends). Labels may drop a sub-heading's prefix ("Ultrawide 2560 x 1080"
// under "Ultrawide" reads "2560 x 1080"); the tag (and every aria-label) stays whole.
export type Tag = { tag: string; label: string };
// Genre + Features carry an All / Any switch bound to their WorkshopFilter field (`genreMatch` / `featureMatch`)
export type GroupMatch = { key: "genreMatch" | "featureMatch"; one: string; plural: string };
export type Group = { id: string; name: string; match?: GroupMatch; subs: { name?: string; tags: Tag[] }[] };
const t = (tag: string, label = tag): Tag => ({ tag, label });
const prefixed = (p: string, rest: string[]) => [t(`${p} Standard Definition`, "Standard Definition"), ...rest.map((r) => t(`${p} ${r}`, r))];
// Steam's "Miscellaneous" group (the wallpaper-relevant features). Left out: "Verified" + "Multi-monitor optimized" (Steam's
// Hidden group — no-ops), "No Animation" (a Script Type tag), "User Shortcut" / "Asset Pack" (not playable wallpapers).
// "In my library": a UI-only pseudo-tag in the same include / exclude sets — ✓ = only what the library has, ✕ = hide it. Never sent
// to Steam (`wireFilter` strips it; the backend ignores "@" tags too) and filtered in Browse's render against the library
// (`inLibrary`), so toggling it needs no request and leaves the prefetched page valid.
export const LIBRARY_TAG = "@library";
export const WF_GROUPS: Group[] = [
  { id: "library", name: "Library", subs: [{ tags: [t(LIBRARY_TAG, "In my library")] }] },
  { id: "age", name: "Age", subs: [{ tags: ["Everyone", "Questionable", "Mature"].map((x) => t(x)) }] },
  // Scene stays even with scene support off: Browse doesn't know it (it's a player-side setting) and Workshop lists scenes anyway
  { id: "type", name: "Type", subs: [{ tags: ["Video", "Scene"].map((x) => t(x)) }] },
  { id: "resolution", name: "Resolution", subs: [
    { name: "Standard", tags: ["Standard Definition", "1280 x 720", "1366 x 768", "1920 x 1080", "2560 x 1440", "3840 x 2160"].map((x) => t(x)) },
    { name: "Ultrawide", tags: prefixed("Ultrawide", ["2560 x 1080", "3440 x 1440"]) },
    { name: "Dual", tags: prefixed("Dual", ["3840 x 1080", "5120 x 1440", "7680 x 2160"]) },
    { name: "Triple", tags: prefixed("Triple", ["4096 x 768", "5760 x 1080", "7680 x 1440", "11520 x 2160"]) },
    { name: "Portrait", tags: prefixed("Portrait", ["720 x 1280", "1080 x 1920", "1440 x 2560", "2160 x 3840"]) },
    { name: "Other", tags: [t("Other resolution", "Other"), t("Dynamic resolution", "Dynamic")] },
  ] },
  { id: "genre", name: "Genre", match: { key: "genreMatch", one: "genre", plural: "genres" }, subs: [{ tags: ["Abstract", "Animal", "Anime", "Cartoon", "CGI", "Cyberpunk", "Fantasy", "Game", "Girls",
    "Guys", "Landscape", "Medieval", "Memes", "MMD", "Music", "Nature", "Pixel art", "Relaxing", "Retro", "Sci-Fi", "Sports",
    "Technology", "Television", "Vehicle", "Unspecified"].map((x) => t(x)) }] },
  { id: "features", name: "Features", match: { key: "featureMatch", one: "feature", plural: "features" }, subs: [{ tags: ["Approved", "Audio responsive", "HDR", "3D", "Customizable",
    "Media Integration", "Puppet Warp", "Video Texture"].map((x) => t(x)) }] },
];

export const SORTS: [string, string][] = [
  ["trend", "Most Popular"], ["mostrecent", "Most Recent"], ["lastupdated", "Recently Updated"],
  ["totaluniquesubscribers", "Most Subscribed"], ["toprated", "Top Rated"],
];
export const PERIODS: [number, string][] = [[1, "Today"], [7, "Week"], [30, "Month"], [90, "3 Months"], [180, "6 Months"], [365, "Year"]];
// the Workshop's sort menu is one list: "Most Popular" once per period ("Most Popular · Week", value "trend:7"), then the
// other sorts — the period isn't a second control (docs/decisions.md § "Filter the Workshop in a column of three-way switches")
export const WS_SORT_OPTIONS = [
  ...PERIODS.map(([d, l]) => ({ value: `trend:${d}`, label: `Most Popular · ${l}` })),
  ...SORTS.filter(([v]) => v !== "trend").map(([v, l]) => ({ value: v, label: l })),
];
export const wsSortValue = (f: WorkshopFilter) => (f.sort === "trend" ? `trend:${f.trendDays}` : f.sort);
export const wsSortPatch = (v: string): Partial<WorkshopFilter> => (v.startsWith("trend:") ? { sort: "trend", trendDays: +v.slice(6) } : { sort: v });

export { WF_DOCK_QUERY };
export const WF_CLOSE_MS = SIDE_CLOSE_MS; // the panel's exit slide: the item sidebar's (index.css `side-out`)
const subscribeDock = (cb: () => void) => { const q = matchMedia(WF_DOCK_QUERY); q.addEventListener("change", cb); return () => q.removeEventListener("change", cb); };
export const useFilterDocked = () => useSyncExternalStore(subscribeDock, () => matchMedia(WF_DOCK_QUERY).matches);

// how many tags are on (include + exclude) — the split button's count
export const useActiveTagCount = (scope: FilterScope = "workshop") =>
  useStore((s) => filterOf(s, scope).include.length + filterOf(s, scope).exclude.length);

// ---- the local filters (the Library, Browse's Wallpaper Engine folder): the same column and semantics as the Workshop's,
// matched here against what each item knows instead of by Steam (docs/decisions.md § "Filter the Library and the local
// Wallpaper Engine folder in the page").

// the groups a scope offers: the Library has no "In my library" row (everything in it is)
export const groupsFor = (scope: FilterScope) => (scope === "library" ? WF_GROUPS.filter((g) => g.id !== "library") : WF_GROUPS);

// what a local item knows, as lower-cased tag names: its tags (Steam's, saved at download, else its project.json's genres +
// the features the file declares — the backend's WorkshopTags.FromProject), its age rating, its type and its resolution
type Facetable = { tags: string[] | null; isScene: boolean; ageRating?: string | null; resolution: string | null };
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
  // an image (an imported still) is neither a Video nor a Scene
  if (x.isScene) f.add("scene"); else if (!IMAGE.test(path)) f.add("video");
  const r = x.resolution ? RES.exec(x.resolution) : null;
  if (r) f.add(`${r[1]} x ${r[2]}`);
  facetCache.set(x, f);
  return f;
}

const AGE = WF_GROUPS.find((g) => g.id === "age")!.subs[0].tags.map((t) => t.tag.toLowerCase());
const GROUP_OF = new Map(WF_GROUPS.flatMap((g) => g.subs.flatMap((s) => s.tags.map((t) => [t.tag.toLowerCase(), g.id] as const))));
// The filter as a test of one item's facets, with the Workshop's rules (the backend's WorkshopTags.Build): OR within a
// group, Genre / Features by their All / Any switch, AND across groups, an excluded tag hides, and any age include or
// exclude drops an item with no age rating (docs/decisions.md § "Drop untagged items under any age filter"). The "@"
// pseudo-tags are the page's own ("In my library"). null = nothing on: every item passes. Guard: probe-filters lib:filter
export function localMatcher(f: WorkshopFilter): ((facets: Set<string>) => boolean) | null {
  const exc = new Set(f.exclude.filter((t) => !t.startsWith("@")).map((t) => t.toLowerCase()));
  const inc = [...new Set(f.include.filter((t) => !t.startsWith("@")).map((t) => t.toLowerCase()))].filter((t) => !exc.has(t));
  if (!inc.length && !exc.size) return null;
  const tests: ((x: Set<string>) => boolean)[] = [];
  const ageInc = inc.filter((t) => AGE.includes(t));
  if (ageInc.length || AGE.some((t) => exc.has(t))) {
    const allowed = (ageInc.length ? ageInc : AGE).filter((t) => !exc.has(t));
    if (!allowed.length) return () => false;
    tests.push((x) => allowed.some((t) => x.has(t)));
  }
  const byGroup = new Map<string, string[]>();
  for (const t of inc) {
    if (AGE.includes(t)) continue;
    const g = GROUP_OF.get(t) ?? `tag:${t}`; // a tag in no group is its own group
    byGroup.set(g, [...(byGroup.get(g) ?? []), t]);
  }
  for (const [g, tags] of byGroup) {
    const all = g === "features" ? f.featureMatch !== "any" : g === "genre" ? f.genreMatch === "all" : false;
    tests.push(all ? (x) => tags.every((t) => x.has(t)) : (x) => tags.some((t) => x.has(t)));
  }
  const hide = [...exc].filter((t) => !AGE.includes(t));
  if (hide.length) tests.push((x) => !hide.some((t) => x.has(t)));
  return (x) => tests.every((t) => t(x));
}

// every tag some item of the list knows — the local column offers only those (a filter nothing could match is noise:
// resolution, say, which a project.json never states)
export function knownTags<T extends Facetable>(items: T[], path: (x: T) => string): Set<string> {
  const k = new Set<string>();
  for (const x of items) for (const t of facetsOf(x, path(x))) k.add(t);
  return k;
}

// the column's groups for a list that knows `known` (null = all, the Workshop): a row shows while some item has its tag or
// while it is on (so it can be turned off), a pseudo-tag always; a sub-heading or a group left empty goes
export function visibleGroups(groups: Group[], known: Set<string> | null, states: Map<string, TagState>): Group[] {
  if (!known) return groups;
  const out: Group[] = [];
  for (const g of groups) {
    const subs = g.subs.map((s) => ({ ...s, tags: s.tags.filter((t) => t.tag.startsWith("@") || known.has(t.tag.toLowerCase()) || states.get(t.tag)) }))
      .filter((s) => s.tags.length);
    if (subs.length) out.push({ ...g, subs });
  }
  return out;
}

// Open or close a page's panel from a user's click (the split button's toggle, the panel's ×). Docked, the grid re-fits its
// columns to the new width: the row the eye is on (the first card wholly showing) stays where it was, as a pointer-focused
// card does for the item sidebar (gridKeys.ts keepCardInView). Read on the click, the layout is clean. Guard: probe-filters
// lib:interplay
export function setFiltersFromClick(page: FilterPage, open: boolean) {
  if (matchMedia(WF_DOCK_QUERY).matches) {
    const sc = document.querySelector<HTMLElement>(page === "library" ? ".lib-scroll" : ".app > .scroll:not(.lib-scroll)");
    const top = sc?.getBoundingClientRect().top ?? 0;
    for (const c of sc?.querySelectorAll<HTMLElement>(".grid > .card [data-morph-id]") ?? []) {
      if (c.getBoundingClientRect().top < top - 1) continue;
      keepCardInView(sc!, c.dataset.morphId!);
      break;
    }
  }
  useStore.getState().setFiltersOpen(page, open);
}
// The filter panel's place on a page (Browse, the Library): on the right, docked beside the grid from WF_DOCK_QUERY up (the
// grid makes room like it does for the item sidebar), else a drawer over the grid. Opened and closed by the top bar's split
// button (components/SortFilterButton.tsx) and the panel's own ×; one right-hand panel at a time (store setFiltersOpen).
// `on` = the page offers filters now. `panel` lingers through the exit slide (WF_CLOSE_MS). `entering`: the docked panel
// slides in only when it's opened — a page that starts with it open (Browse is built on each visit, the kept Library shows
// again) just shows it; a drawer always slides (it opens only on a click).
export function useFilterOpen(page: FilterPage, on: boolean) {
  const docked = useFilterDocked();
  return useStore((s) => on && (docked ? !(page === "library" ? s.libFilterColHidden : s.filterColHidden) : s.filterDrawer === page));
}
export function useFilterPanel(page: FilterPage, on: boolean) {
  const motion = useMotion();
  const docked = useFilterDocked();
  const open = useFilterOpen(page, on);
  const panel = useLinger<"dock" | "drawer">(open ? (docked ? "dock" : "drawer") : null, WF_CLOSE_MS, motion);
  const close = useCallback(() => setFiltersFromClick(page, false), [page]);
  const [wasOpen, setWasOpen] = useState(open);
  const [entering, setEntering] = useState(false);
  if (wasOpen !== open) { setWasOpen(open); setEntering(open && motion); } // follow during render
  useEffect(() => { if (!entering) return; const t = setTimeout(() => setEntering(false), 400); return () => clearTimeout(t); }, [entering]);
  // a drawer left open goes when the window docks the panel (the docked state is its own) or the page stops offering
  // filters, and when the page goes (Browse unmounts; the kept Library hides: a layout effect's cleanup runs then too)
  const drawerMine = useStore((s) => s.filterDrawer === page);
  useEffect(() => { if (drawerMine && (docked || !on)) useStore.setState({ filterDrawer: null }); }, [drawerMine, docked, on]);
  useLayoutEffect(() => () => { setEntering(false); if (useStore.getState().filterDrawer === page) useStore.setState({ filterDrawer: null }); }, [page]);
  return { docked, open, panel, entering, close };
}
