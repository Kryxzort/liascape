import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { filterOf, useStore, type FilterScope, type TagState } from "../store";
import type { WorkshopFilter } from "../api/client";
import { useMotion } from "./motion";
import { useLinger } from "../hooks/useLinger";
import { useStableFn } from "../hooks/useStableFn";
import { type MorphSource, morph, snapshot } from "../hooks/filterMorph";

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

// the column docks from this width; below it, it's a drawer. 1100: with the item sidebar docked too (≥ 900 px, 300–400 px) a
// 1100 px window still leaves the grid ~540 px (3 Small cards); at 900–1099 the two side by side left 370–540 px.
export const WF_DOCK_QUERY = "(min-width: 1100px)";
export const WF_DOCK_MS = 220; // the docked column folding away (index.css `wf-dock-out`)
export const WF_CLOSE_MS = 170; // the drawer's exit slide (index.css `wf-out`)
const subscribeDock = (cb: () => void) => { const q = matchMedia(WF_DOCK_QUERY); q.addEventListener("change", cb); return () => q.removeEventListener("change", cb); };
export const useFilterDocked = () => useSyncExternalStore(subscribeDock, () => matchMedia(WF_DOCK_QUERY).matches);

// how many tags are on (include + exclude) — the drawer button's count
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

// The column's place on a page (Browse, the Library): docked from WF_DOCK_QUERY up — folded away and back with the
// pill ⇄ title morph (hooks/filterMorph.ts) while the grid glides — else a drawer the "Filters · N" pill opens. `on` = the
// page shows a column now. Each page folds its own (store filterColHidden / libFilterColHidden).
// COOL: the docked column slides out / back in (WF_DOCK_MS) and the grid glides by its width instead of jumping — the margin
// flips at once (the grid re-fits once), `.wf-shift-*` plays the offset back to 0 on transform only (n % 2 alternates two
// identical keyframes so a quick re-toggle restarts it). Only on a toggle: a tab visit / a resize just shows the column.
export function useFilterColumn(page: "browse" | "library", on: boolean) {
  const motion = useMotion();
  const docked = useFilterDocked();
  const colHidden = useStore((s) => (page === "library" ? s.libFilterColHidden : s.filterColHidden));
  const setColHidden = useStore((s) => s.setFilterColHidden);
  const dockCol = useLinger(on && docked && !colHidden ? true : null, WF_DOCK_MS, motion);
  const [shift, setShift] = useState<{ dir: "in" | "out"; n: number } | null>(null);
  useEffect(() => { if (!shift) return; const t = setTimeout(() => setShift(null), 420); return () => clearTimeout(t); }, [shift]);
  // the pill ⇄ title morph: snapshot what's being left before the change, fly it onto its counterpart after the commit —
  // this page's own (the Library's stays in the document while Browse shows)
  const morphFrom = useRef<MorphSource | null>(null);
  const el = (what: "open" | "title") => document.querySelector(`[data-wf-${what}][data-wf-page="${page}"]`);
  const toggleCol = useStableFn(() => {
    if (motion) {
      morphFrom.current = snapshot(el(colHidden ? "open" : "title"));
      setShift((s) => ({ dir: colHidden ? "in" : "out", n: (s?.n ?? 0) + 1 }));
    }
    setColHidden(!colHidden, page);
  });
  useLayoutEffect(() => {
    const from = morphFrom.current; morphFrom.current = null;
    if (from && shift) morph(from, el(shift.dir === "in" ? "title" : "open"));
  }, [shift]); // eslint-disable-line react-hooks/exhaustive-deps
  const [drawerOpen, setDrawerOpen] = useState(false);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);
  if (drawerOpen && (docked || !on)) setDrawerOpen(false); // follow during render: a wider window / another source
  const drawer = useLinger(on && !docked && drawerOpen ? true : null, WF_CLOSE_MS, motion);
  const openFilters = useStableFn(() => (docked ? toggleCol() : setDrawerOpen(true)));
  // leaving a page kept mounted (the Library): no drawer and no glide left to replay when it shows again
  const reset = useCallback(() => { setDrawerOpen(false); setShift(null); }, []);
  return { docked, open: docked && !colHidden, dockCol, shift, shiftClass: shift ? ` wf-shift-${shift.dir}-${shift.n % 2}` : "",
    toggleCol, drawer, closeDrawer, openFilters, reset };
}
