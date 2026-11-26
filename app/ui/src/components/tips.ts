import { useStore } from "../store";

// The one-time tips (components/Tip.tsx): their ids, as settings `seenTips` holds the dismissed ones
export type TipId = "cardMenu" | "playlists" | "itemSettings" | "downloadModes";
export const TIP_IDS: TipId[] = ["cardMenu", "playlists", "itemSettings", "downloadModes"];

// not dismissed, and the settings read (no tip before them: one that popped in a moment after its page would push it down)
export const useTipOpen = (id: TipId) => useStore((s) => {
  const seen = s.settings?.seenTips;
  return !!s.settings && !(Array.isArray(seen) && seen.includes(id));
});
