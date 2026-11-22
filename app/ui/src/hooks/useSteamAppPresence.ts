import { useEffect, useState } from "react";
import { api } from "../api/client";

// How often the page repeats "the Workshop shows" while it does: well inside the backend's 90 s heartbeat timeout
// (Helpers/SteamClientHold.cs), so one late beat never counts as leaving.
const BEAT_MS = 30_000;

type ShellBridge = { onShownChange?: (cb: (v: boolean) => void) => (() => void) | void; isShown?: () => Promise<boolean> };
const shell = () => (window as unknown as { liascape?: ShellBridge }).liascape;

// The window is on screen: not hidden or minimized. The shell says so (preload `isShown` once, then `onShownChange`): with
// background throttling off, Chromium keeps `visibilityState` "visible" in a hidden window. Until the shell answers it
// counts as not shown (a page reloaded while hidden). In a plain browser `visibilityState` is all there is.
function useWindowShown(): boolean {
  const [shown, setShown] = useState<boolean | null>(() => (shell()?.isShown ? null : true));
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  useEffect(() => {
    const sync = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", sync);
    let heard = false; // an event that came first is newer than the answer
    const off = shell()?.onShownChange?.((v) => { heard = true; setShown(v); });
    shell()?.isShown?.().then((v) => { if (!heard) setShown(!!v); }, () => { if (!heard) setShown(true); });
    return () => { heard = true; document.removeEventListener("visibilitychange", sync); if (typeof off === "function") off(); };
  }, []);
  return shown === true && visible;
}

// Tells the backend whether "Use the Steam app" may keep its Steam connection: while the Workshop shows on Browse in a
// shown window it does (Steam shows the user playing Wallpaper Engine, one connection for the visit instead of a blink per
// download); on leaving, a linger starts there. `onBrowseWorkshop` = the Browse tab with the Workshop source, in that mode.
// Guard: probe-steam browse:appPresence
export function useSteamAppPresence(onBrowseWorkshop: boolean) {
  const showing = useWindowShown() && onBrowseWorkshop;
  useEffect(() => {
    if (!showing) return;
    api.steamAppPresence(true);
    const beat = setInterval(() => api.steamAppPresence(true), BEAT_MS);
    const leave = () => api.steamAppPresence(false, true); // the window closes or reloads
    addEventListener("pagehide", leave);
    return () => { clearInterval(beat); removeEventListener("pagehide", leave); api.steamAppPresence(false); };
  }, [showing]);
}
