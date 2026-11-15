import type { Wallpaper } from "../api/client";

// Auto-import on + the "subscribe" download mode: every subscription lands in the library, so a Workshop item's download IS
// its subscription and its download controls say Subscribe (the Browse sidebar's buttons, the card's button, the selection
// toolbar, the status line). The other modes (the Steam app / page, a steamcmd copy) keep Download.
// Guard: probe-steam steam:subMerge:*
export const subscribeIsDownload = (settings: Record<string, unknown> | null | undefined) =>
  !!settings?.autoAddWeWallpapersToLibrary && settings?.workshopDownloadMode === "subscribe";
// a Workshop source's item (a WE-local folder's is on disk already: its Download imports it)
export const isWorkshopItem = (w: Pick<Wallpaper, "workshopId" | "pageUrl">) => !!w.workshopId && w.pageUrl.startsWith("http");

// Why an Unsubscribe can't happen now, else null — the backend's WorkshopDownloader.UnsubscribeBlocked (its endpoints refuse
// with the same words): without a usable sign-in the app stays disconnected from Steam for unsubscribes, except "Use the
// Steam app" (the running client is its sign-in) and "Open in the Steam app" while it unsubscribes through pages
// (`pageUnsubscribes`). Unknown yet (the status not read): not blocked, the backend has the last word. Every Unsubscribe
// control shows the reason disabled: the Library card's button and the Delete key (the status bar), the sidebar tiles and their
// right-click entry, the Browse sidebar's Unsubscribe. Guard: probe-steam side:unsub:signedOut, steam:subToggle:signedOut
export const UNSUB_SIGN_IN = "Sign in to Steam to unsubscribe";
export function unsubBlocked(settings: Record<string, unknown> | null | undefined,
  steam: { signedIn: boolean; rejected?: boolean; usable?: boolean; pageUnsubscribes?: boolean } | null | undefined): string | null {
  if (!steam) return null;
  const mode = settings?.workshopDownloadMode;
  if (mode === "steamapp" || (mode === "steampage" && steam.pageUnsubscribes !== false)) return null;
  return (steam.usable ?? (steam.signedIn && !steam.rejected)) ? null : UNSUB_SIGN_IN;
}
