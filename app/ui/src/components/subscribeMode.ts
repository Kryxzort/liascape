import type { Wallpaper } from "../api/client";

// Auto-import on + the "subscribe" download mode: every subscription lands in the library, so a Workshop item's download IS
// its subscription and its download controls say Subscribe (the Browse sidebar's buttons, the card's button, the selection
// toolbar, the status line). "Use the Steam app" keeps Download.
// Guard: probe-steam steam:subMerge:*
export const subscribeIsDownload = (settings: Record<string, unknown> | null | undefined) =>
  !!settings?.autoAddWeWallpapersToLibrary && settings?.workshopDownloadMode === "subscribe";

type SteamState = { signedIn: boolean; rejected?: boolean; usable?: boolean } | null | undefined;
// a sign-in the backend can use (/steam/status `usable`); unknown yet (the status not read): taken as usable, the backend has
// the last word
const signInUsable = (steam: SteamState) => !steam || (steam.usable ?? (steam.signedIn && !steam.rejected));

// What a Workshop item's download does in the chosen mode, the line in the import-from-a-link dialog (the item sidebar's
// buttons say Subscribe themselves, with no line under them): every way subscribes to get it. "Subscribe with Steam login" without a usable sign-in goes straight to the item's Steam page (the
// fallback order's last step, WorkshopDownloader.AcquireViaSubscribeAsync), so the words say that. Merged (the buttons say
// Subscribe) and unknown modes: no line. Guard: probe-steam side:getHint
export function downloadHint(settings: Record<string, unknown> | null | undefined, steam: SteamState): string | null {
  if (subscribeIsDownload(settings) && signInUsable(steam)) return null;
  switch (settings?.workshopDownloadMode) {
    case "subscribe": return signInUsable(steam) ? "Subscribes with your Steam login, then adds it to your library"
      : "Opens its Steam page for you to subscribe, then adds it to your library";
    case "steamapp": return "Subscribes through the Steam app, then adds it to your library";
    default: return null;
  }
}
// a Workshop source's item (a WE-local folder's is on disk already: its Download imports it)
export const isWorkshopItem = (w: Pick<Wallpaper, "workshopId" | "pageUrl">) => !!w.workshopId && w.pageUrl.startsWith("http");

// THE rule for every Workshop action, the backend's WorkshopDownloader.Blocked (its endpoints refuse with the same words): why
// the chosen download mode can't do it now, else null. Every action falls back down the order to the item's Steam page
// (docs/decisions.md § "Offer two Workshop download modes, the Steam page the last resort"), which can subscribe and
// unsubscribe but never make a one-off copy: so the one action that can be off is "Subscribe with Steam login"'s "Download
// without subscribing" without a usable sign-in ("Use the Steam app"'s fails at the click when neither the client nor a
// sign-in can). Unknown yet (the status not read): not blocked, the backend has the last word. Every control of an action
// shows the reason, disabled, up front: "Download without subscribing" (its menu's note, GET /workshop/one-off), and the
// other actions' controls (Download, Subscribe, Unsubscribe) keep the same wiring.
// Guard: probe-steam side:oneOff:modes, side:blocked:download
export type WorkshopAction = "download" | "subscribe" | "unsubscribe" | "oneOff";
export function actionBlocked(settings: Record<string, unknown> | null | undefined, steam: SteamState, a: WorkshopAction): string | null {
  if (a === "oneOff" && settings?.workshopDownloadMode === "subscribe" && !signInUsable(steam)) return "Sign in to Steam to download without subscribing";
  return null;
}
export const unsubBlocked = (settings: Record<string, unknown> | null | undefined, steam: SteamState) => actionBlocked(settings, steam, "unsubscribe");
