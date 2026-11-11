// Debug overlay + self-drive bridge (FPS/metrics HUD + a socket-driven self-test), web-native:
//  • On-screen HUD (top-right): fps · true 1%/0.1% low · frametime · visible/total cards · anim layers
//    · JS heap MB · long-task rate.
//  • `window.liascapeDbg` control bridge — replaces the Unix socket; drive it headlessly from the Electron
//    probe via webContents.executeJavaScript("liascapeDbg.metrics()"). No socat.
// Enabled by `?debug` (or `localStorage.liascapeDbg=1`). Electron: launch with LIASCAPE_DEBUG=1 (main.js adds it).
export const DEBUG_ON =
  new URLSearchParams(location.search).has("debug") || localStorage.getItem("liascapeDbg") === "1";
