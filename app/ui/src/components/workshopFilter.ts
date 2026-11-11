import { useSyncExternalStore } from "react";
import { useStore } from "../store";

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
// "In my library" (owner 2026-11-11: "there should probably be a option to exclude the wallpapers already in library from
// showing"): a UI-only pseudo-tag in the same include / exclude sets — ✓ = only what the library has, ✕ = hide it. Never sent
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
export const useActiveTagCount = () => useStore((s) => s.browseFilter.include.length + s.browseFilter.exclude.length);
