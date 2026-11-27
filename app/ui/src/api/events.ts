import { useEffect } from "react";
import { API, withToken, type LibraryItem, type LibraryOp, type SteamTodo, type HiddenState } from "./client";

export type LiascapeEvent =
  | { type: "wallpaper-changed"; payload: { path: string | null } }
  | { type: "settings-changed"; payload: Record<string, unknown> }
  | { type: "scene-crashed"; payload: { path: string } }
  | { type: "scene-vram-stopped"; payload: { path: string; usedMib: number; limitMib: number; message: string } }
  // why no scene can play here (the scene renderer is missing), or null once they can again: never a crash mark
  | { type: "scenes-blocked"; payload: { reason: string | null } }
  // liascape-player's low-VRAM hold took the wallpapers ("Paused: low video memory — 345 MB free, needs 4408 MB"), or
  // null once it let go
  | { type: "vram-hold"; payload: { message: string | null } }
  // `liascape toggle-loop-current` toggled "keep playing this one" (the rotation holds what plays)
  // `toggle-pause` ran (AppOps): the wallpaper's own pause, for the in-app background (components/WallpaperBg.tsx)
  | { type: "pause-changed"; payload: { paused: boolean } }
  | { type: "toggle-loop-current"; payload: { keep: boolean; path: string | null; message: string } }
  // `status`: a Workshop download's step in words ("Subscribing on Steam…", "Click Subscribe in Steam, then it downloads by
  // itself…")
  | { type: "download-progress"; payload: { id: string; value: number; done?: boolean; status?: string } }
  // finished without a usable sign-in: `openedInSteam` items were opened in the Steam app and `message` says what to click
  | { type: "unsub-progress"; payload: { done: number; total: number; currentId: string; finished?: boolean; openedInSteam?: number; message?: string | null; error?: string } }
  | { type: "steam-todo"; payload: SteamTodo }
  // the Browse sidebar's Subscribe (Web/WorkshopSubOps.cs): its step while it runs; `done` at the end (`skipped` = the user
  // skipped its Steam to-do entry, `error` = it failed)
  | { type: "subscribe-progress"; payload: { id: string; value: number; status: string | null; done?: boolean; error?: string | null; skipped?: boolean } }
  | { type: "library-synced"; payload: { count: number } }
  | { type: "hidden-changed"; payload: HiddenState }
  // the backend changed an item itself: only the fields it sends (a volume keybind → volumeOverride; a scene's
  // loudness estimate / measurement → the loudness* fields)
  | { type: "library-item-changed"; payload: { path: string } & Partial<Pick<LibraryItem, "volumeOverride" | "hasCrashed" | "loudnessLufs" | "loudnessEstimated" | "loudnessSeconds" | "loudnessConfidence" | "loudnessNote" | "fontStandIns"
    | "downloadIncomplete" | "filesVersion" | "thumbnailPath" | "animatedThumbnailPath" | "presetReason" | "resolution" | "ageRating" | "tags">> }
  // the background scene-loudness queue (imports and syncs measure every scene not measured yet): shaped like unsub-progress
  | { type: "scene-loudness-progress"; payload: { done: number; total: number; currentId: string; finished?: boolean; cancelled?: boolean } }
  // the library's background operations running now, the whole list on each change (the top bar's progress line)
  | { type: "library-ops"; payload: { ops: LibraryOp[] } }
  | { type: "playlist-changed"; payload: { client: string | null } }
  | { type: "steam-qr"; payload: { png: string } }
  // the signed-in account's Workshop favourites changed in the backend's cache (a page of the first load, a star here or on
  // Steam, the id diff, the count check): the app-wide version it's at now and the first load's progress, never the ids
  // (Helpers/WorkshopFavorites.cs; the page re-reads GET /workshop/my-favorites)
  | { type: "workshop-favorites"; payload: { version: number; loading: { done: number; total: number | null } | null } }
  | { type: "steam-signed-in"; payload: { signedIn: boolean; accountName: string; daysLeft: number | null; mode: string } }
  // the sign-in ended (signed out, or Steam turned it down): /steam/status's shape (SteamOps.SignInLost)
  | { type: "steam-status"; payload: { signedIn: boolean; rejected?: boolean; accountName: string; daysLeft: number | null; mode: string; usable?: boolean } }
  | { type: "steam-cooldown"; payload: { cooldownMs: number } }
  | { type: "steam-qr-error"; payload: { message: string } }
  | { type: "steam-qr-cancelled"; payload: null }
  // the password sign-in (SteamOps): what Steam wants next — `email` (hint = the address's domain), `device` (the mobile
  // authenticator's code), `confirm` (approve in the Steam app, or type its code); `retry` = the last code was wrong
  | { type: "steam-login-code"; payload: { kind: "email" | "device" | "confirm"; hint: string | null; retry: boolean } }
  | { type: "steam-login-error"; payload: { message: string; rateLimited: boolean } }
  | { type: "steam-login-cancelled"; payload: null };

// API: subscribe to backend push events over WS /events. Auto-reconnects. Same-origin (the installed
// app: the backend serves the UI, API = "") connects to this page's own origin — returning here
// instead would leave the installed app without a single push event (rotation/keybind switches,
// download progress, Steam sign-in).
// `onReconnect`: every open after the first — the backend restarted (or the socket dropped): whatever changed in the
// gap was never pushed, so the page re-reads what it mirrors (store.resync).
// `eventsOpened`: the page's first socket is up. The store's first reads run beside the socket's opening, so what the
// backend pushed before it was up never reached the page (store.init re-reads /current on it).
let markOpened: () => void;
export const eventsOpened = new Promise<void>((r) => (markOpened = r));
export function useEvents(onEvent: (e: LiascapeEvent) => void, onReconnect?: () => void) {
  useEffect(() => {
    const base = (API || location.origin).replace(/^http/, "ws");
    let ws: WebSocket | null = null;
    let stop = false;
    let opened = false;
    let retry: ReturnType<typeof setTimeout>;
    const connect = () => {
      if (stop) return;
      ws = new WebSocket(withToken(`${base}/events`));
      ws.onopen = () => { if (opened) onReconnect?.(); opened = true; markOpened(); };
      ws.onmessage = (m) => {
        try { onEvent(JSON.parse(m.data)); } catch { /* ignore */ }
      };
      ws.onclose = () => { if (!stop) retry = setTimeout(connect, 1000); };
      ws.onerror = () => ws?.close();
    };
    connect();
    return () => { stop = true; clearTimeout(retry); ws?.close(); };
  }, [onEvent, onReconnect]);
}
