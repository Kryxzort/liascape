// Settings levels (docs/decisions.md § "Use four settings levels, Standard by default, and never reset a hidden value"): how much of
// Settings shows. `settingsLevel` is an ordinary saved setting the backend never reads; each level shows its own rows and
// every row of the levels below it. A hidden row keeps its value and keeps working (.claude/rules/ui/state-and-api.md § Settings page).
// The picker sits in the top bar beside the tabs while Settings is open (App.tsx).
export type Level = "basic" | "standard" | "advanced" | "expert";
export const LEVELS: Level[] = ["basic", "standard", "advanced", "expert"];
export const LEVEL_LABEL: Record<Level, string> = { basic: "Basic", standard: "Standard", advanced: "Advanced", expert: "Expert" };
export const levelOf = (v: unknown): Level => (LEVELS as string[]).includes(v as string) ? (v as Level) : "standard";
export const rank = (l: Level) => LEVELS.indexOf(l);

// The level each setting's row lives at, by settings key (a row without a key passes its own `lv`). Also what the
// "hidden but changed" note at the top of Settings counts.
export const LEVEL_OF_KEY: Record<string, Level> = {
  // basic
  volume: "basic", noAudio: "basic", normalizeAudio: "basic", autoMute: "basic", pauseWhenCovered: "basic",
  globalSwitchWhenVideoEnds: "basic", globalIntervalSeconds: "basic", globalTransitionEnabled: "basic",
  cardSize: "basic", allowScenes: "basic",
  // standard
  normalizeTargetLufs: "standard", speed: "standard", loop: "standard",
  autoMuteOnlyIfMprisActive: "standard", autoMuteDelayMs: "standard", autoUnmuteDelayMs: "standard",
  globalMaxPlaySeconds: "standard", globalSeparateSceneTiming: "standard", globalSwitchScenesAfterSeconds: "standard",
  globalPlaylistStart: "standard", autoAddLibraryToPlaylist: "standard",
  videoScale: "standard", videoFpsCap: "standard", autoThrottleScenes: "standard", vramLowMode: "standard",
  thumbnailAspect: "standard", glows: "standard", morphs: "standard", autoPlayGifs: "standard", autoPlayVideoThumbs: "standard",
  autoAddWeWallpapersToLibrary: "standard",
  // advanced
  disableCache: "advanced", stayPausedWhenSwitching: "advanced", restartMpvpaperEverySeconds: "advanced",
  restartOnlyAtPlaylistChangeover: "advanced", autoMuteMinLevelDb: "advanced", hwDec: "advanced",
  demuxerMaxMib: "advanced", demuxerMaxBackMib: "advanced", limitVramPerScene: "advanced", sceneVramLimitMib: "advanced",
  liveWallpaperBehindAllTabs: "advanced", copyFilesInsteadOfSymlinking: "advanced", replaceDirectWithWorkshop: "advanced",
  sceneTransitionDelayMs: "advanced", playerEngine: "advanced", transitionMethod: "advanced", fullLiveSyncOffsetMs: "advanced",
  volumeKeyTarget: "advanced",
  // expert
  rotateWhileParked: "expert", debugMode: "expert", debugOverlay: "expert",
};
