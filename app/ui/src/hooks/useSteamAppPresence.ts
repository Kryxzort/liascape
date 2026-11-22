import { useEffect, useState } from "react";
import { api } from "../api/client";

// How often the page repeats "the Workshop shows" while it does: well inside the backend's 90 s heartbeat timeout
// (Helpers/SteamClientHold.cs), so one late beat never counts as leaving.
const BEAT_MS = 30_000;

// The window is on screen: not hidden or minimized. The shell says so (preload `onShownChange`): with background throttling
// off, Chromium keeps `visibilityState` "visible" in a hidden window. In a plain browser `visibilityState` is all there is.
function useWindowShown(): boolean {
  const [shown, setShown] = useState(true);
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  useEffect(() => {
    const sync = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", sync);
    (window as unknown as { liascape?: { onShownChange?: (cb: (v: boolean) => void) => void } }).liascape?.onShownChange?.(setShown);
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);
  return shown && visible;
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
