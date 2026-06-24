import { useState } from "react";
import { useStore } from "../store";
import { Select } from "./Select";

// Full Steam Workshop filter taxonomy. Genres/Features/AgeRating/Resolution are
// requiredtags[] (AND-filtered server-side by SteamWorkshopScraper).
const SORTS: [string, string][] = [
  ["trend", "Most Popular"], ["mostrecent", "Most Recent"], ["lastupdated", "Recently Updated"],
  ["totaluniquesubscribers", "Most Subscribed"], ["toprated", "Top Rated"],
];
const PERIODS: [number, string][] = [[1, "Today"], [7, "Week"], [30, "Month"], [90, "3 Months"], [180, "6 Months"], [365, "Year"]];
const TYPES: [string, string][] = [["", "All types"], ["Video", "Video"], ["Scene", "Scene"]];
const AGE_RATINGS: [string, string][] = [["", "Any age"], ["Everyone", "Everyone"], ["Questionable", "Questionable"], ["Mature", "Mature"]];
const RESOLUTIONS = [
  "", "Standard Definition", "1280 x 720", "1366 x 768", "1920 x 1080", "2560 x 1440", "3840 x 2160",
  "Ultrawide Standard Definition", "Ultrawide 2560 x 1080", "Ultrawide 3440 x 1440",
  "Dual Standard Definition", "Dual 3840 x 1080", "Dual 5120 x 1440", "Dual 7680 x 2160",
  "Triple Standard Definition", "Triple 4096 x 768", "Triple 5760 x 1080", "Triple 7680 x 1440", "Triple 11520 x 2160",
  "Portrait Standard Definition", "Portrait 720 x 1280", "Portrait 1080 x 1920", "Portrait 1440 x 2560", "Portrait 2160 x 3840",
  "Other resolution", "Dynamic resolution",
];
const GENRES = ["Abstract", "Animal", "Anime", "Cartoon", "CGI", "Cyberpunk", "Fantasy", "Game", "Girls", "Guys",
  "Landscape", "Medieval", "Memes", "MMD", "Music", "Nature", "Pixel art", "Relaxing", "Retro", "Sci-Fi",
  "Sports", "Technology", "Television", "Vehicle", "Unspecified"];
// Steam's "Miscellaneous" group (the wallpaper-relevant features). Excluded: "Verified" +
// "Multi-monitor optimized" (Steam's Hidden group — no-ops), "No Animation" (a Script Type tag, not a
// wallpaper feature), and "User Shortcut"/"Asset Pack" (asset-section, not playable wallpapers).
const FEATURES = ["Approved", "Audio responsive", "HDR", "3D", "Customizable",
  "Media Integration", "Puppet Warp", "Video Texture"];

export function WorkshopFilterBar() {
  const f = useStore((s) => s.browseFilter);
  const setF = useStore((s) => s.setBrowseFilter);
  const [open, setOpen] = useState(false);
  const toggle = (list: string[], val: string, key: "genres" | "features") =>
    setF({ [key]: list.includes(val) ? list.filter((x) => x !== val) : [...list, val] });
  const activeCount = f.genres.length + f.features.length + (f.type ? 1 : 0)
    + (f.ageRating ? 1 : 0) + (f.resolution ? 1 : 0);

  return (
    <div className="wfilter">
      <Select value={f.sort} onChange={(v) => setF({ sort: v })}
        options={SORTS.map(([v, l]) => ({ value: v, label: l }))} />
      {f.sort === "trend" && (
        <Select value={f.trendDays} onChange={(v) => setF({ trendDays: +v })}
          options={PERIODS.map(([v, l]) => ({ value: String(v), label: l }))} />
      )}
      <Select value={f.type} onChange={(v) => setF({ type: v })}
        options={TYPES.map(([v, l]) => ({ value: v, label: l }))} />
      <Select value={f.ageRating ?? ""} onChange={(v) => setF({ ageRating: v })}
        options={AGE_RATINGS.map(([v, l]) => ({ value: v, label: l }))} />
      <Select value={f.resolution ?? ""} onChange={(v) => setF({ resolution: v })}
        options={[{ value: "", label: "Any resolution" }, ...RESOLUTIONS.filter((r) => r).map((r) => ({ value: r, label: r }))]} />
      <button className={`pill${activeCount ? " active" : ""}`} onClick={() => setOpen((o) => !o)}>
        Filters{activeCount ? ` · ${activeCount}` : ""}
      </button>
      {open && (
        <div className="wfilter-pop">
          <div className="wf-group">Genres</div>
          <div className="chips">
            {GENRES.map((g) => (
              <button key={g} className={`chip${f.genres.includes(g) ? " on" : ""}`} onClick={() => toggle(f.genres, g, "genres")}>{g}</button>
            ))}
          </div>
          <div className="wf-group">Features</div>
          <div className="chips">
            {FEATURES.map((g) => (
              <button key={g} className={`chip${f.features.includes(g) ? " on" : ""}`} onClick={() => toggle(f.features, g, "features")}>{g}</button>
            ))}
          </div>
          <div className="wf-actions">
            <button className="btn ghost" onClick={() => setF({ genres: [], features: [], type: "", ageRating: "", resolution: "" })}>Clear</button>
            <button className="btn accent" onClick={() => setOpen(false)}>Done</button>
          </div>
        </div>
      )}
    </div>
  );
}
