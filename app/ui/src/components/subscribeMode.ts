import type { Wallpaper } from "../api/client";

// Auto-import on + the "subscribe" download mode: every subscription lands in the library, so a Workshop item's download IS
// its subscription and its download controls say Subscribe (the Browse sidebar's buttons, the card's button, the selection
// toolbar, the status line). The other modes (the Steam app / page, a steamcmd copy) keep Download.
// Guard: probe-steam steam:subMerge:*
export const subscribeIsDownload = (settings: Record<string, unknown> | null | undefined) =>
  !!settings?.autoAddWeWallpapersToLibrary && settings?.workshopDownloadMode === "subscribe";
// a Workshop source's item (a WE-local folder's is on disk already: its Download imports it)
export const isWorkshopItem = (w: Pick<Wallpaper, "workshopId" | "pageUrl">) => !!w.workshopId && w.pageUrl.startsWith("http");
