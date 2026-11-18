import type { Wallpaper } from "../api/client";

// Auto-import on + the "subscribe" download mode: every subscription lands in the library, so a Workshop item's download IS
// its subscription and its download controls say Subscribe (the Browse sidebar's buttons, the card's button, the selection
// toolbar, the status line). The other modes (the Steam app / page) keep Download.
// Guard: probe-steam steam:subMerge:*
export const subscribeIsDownload = (settings: Record<string, unknown> | null | undefined) =>
  !!settings?.autoAddWeWallpapersToLibrary && settings?.workshopDownloadMode === "subscribe";
// What a Workshop item's Download / "Download & Apply" do in the chosen mode, the line under them in the Browse sidebar, so
// they and the subscription card's Subscribe below never read as contradicting: every mode subscribes to get it.
// Merged (the buttons say Subscribe) and unknown modes: no line. Guard: probe-steam side:getHint
export function downloadHint(settings: Record<string, unknown> | null | undefined): string | null {
  if (subscribeIsDownload(settings)) return null;
  switch (settings?.workshopDownloadMode) {
    case "subscribe": return "Subscribes with your Steam login, then adds it to your library";
    case "steamapp": return "Subscribes through the Steam app, then adds it to your library";
    case "steampage": return "Opens its Steam page for you to subscribe, then adds it to your library";
    default: return null;
  }
}
// a Workshop source's item (a WE-local folder's is on disk already: its Download imports it)
export const isWorkshopItem = (w: Pick<Wallpaper, "workshopId" | "pageUrl">) => !!w.workshopId && w.pageUrl.startsWith("http");

// THE rule for every Workshop action, the backend's WorkshopDownloader.Blocked (its endpoints refuse with the same words): why
// the chosen download mode can't do it now, else null. Each mode only its own way, never another's: "Subscribe with Steam
// login" without a usable sign-in reaches Steam for nothing (every action off, "Sign in to Steam to …"), a Steam page can
// only subscribe (no one-off), "Use the Steam app"
// does all of it through the client. Merged (auto-import on + "subscribe") a Download is the subscription and says so. Unknown yet (the status not read):
// not blocked, the backend has the last word. Every control of the action shows the reason, disabled, up front: Download (the
// Browse sidebar's buttons, the card's button, the selection toolbar, Enter / double-click via the store), Subscribe
// (SubToggle), Unsubscribe (the Library card's button and the Delete key, the sidebar tiles and their right-click entry,
// Browse's Unsubscribe), "Download without subscribing" (its menu's note, GET /workshop/one-off).
// Guard: probe-steam side:blocked:*, side:unsub:signedOut, steam:subToggle:signedOut, side:oneOff:modes
export type WorkshopAction = "download" | "subscribe" | "unsubscribe" | "oneOff";
export const UNSUB_SIGN_IN = "Sign in to Steam to unsubscribe";
const SIGN_IN: Record<WorkshopAction, string> = {
  download: "Sign in to Steam to download", subscribe: "Sign in to Steam to subscribe", unsubscribe: UNSUB_SIGN_IN,
  oneOff: "Sign in to Steam to download without subscribing",
};
type SteamState = { signedIn: boolean; rejected?: boolean; usable?: boolean } | null | undefined;
export function actionBlocked(settings: Record<string, unknown> | null | undefined, steam: SteamState, a: WorkshopAction): string | null {
  const mode = settings?.workshopDownloadMode;
  if (a === "download" && subscribeIsDownload(settings)) a = "subscribe";
  if (mode === "subscribe") return !steam || (steam.usable ?? (steam.signedIn && !steam.rejected)) ? null : SIGN_IN[a];
  if (mode === "steampage") return a === "oneOff" ? "A Steam page can only subscribe" : null;
  return null;
}
export const unsubBlocked = (settings: Record<string, unknown> | null | undefined, steam: SteamState) => actionBlocked(settings, steam, "unsubscribe");
