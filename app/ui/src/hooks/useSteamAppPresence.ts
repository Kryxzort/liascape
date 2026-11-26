import { useEffect } from "react";
import { api } from "../api/client";

// Until the backend names its interval (its first answer), the page beats this often: the backend's own default
// (Helpers/SteamClientHold.cs HeartbeatEvery).
const BEAT_MS = 5_000;

// Tells the backend the Liascape window is open, so "Use the Steam app" keeps its Steam connection (Steam shows the user
// playing Wallpaper Engine) from its first Workshop operation until the window closes: one connection while the app is open,
// none flickering on and off as the user moves between tabs. A beat every few seconds at the interval the backend names in
// its answer; the backend lets go a few beats after the last one (a closed or crashed window), never for its own lifetime
// (docs/decisions.md § "Hold the Steam app connection while the Liascape window is open"). `on` = that download mode.
// Guard: probe-steam browse:appPresence
export function useSteamAppPresence(on: boolean) {
  useEffect(() => {
    if (!on) return;
    let timer: ReturnType<typeof setTimeout> | undefined, alive = true;
    const beat = async () => {
      const every = await api.steamAppPresence().then((r) => r?.beatMs ?? BEAT_MS, () => BEAT_MS);
      if (alive) timer = setTimeout(beat, every > 0 ? every : BEAT_MS);
    };
    void beat();
    return () => { alive = false; clearTimeout(timer); };
  }, [on]);
}
