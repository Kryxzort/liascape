// the rotation rows' hints (Settings → Rotation and the playlist modal). Every limit: 0 = off. `min` / `max` get the
// scene clause only while "Separate timing for scenes" is off (on, scenes + still images have their own row).
export const ROT_HINT = {
  every: "switches wallpapers in a playlist on a simple timer",
  min: "plays each wallpaper at least this long, then switches at the next video end. 0 turns the minimum off.",
  minScenes: " Scenes and pictures play this long.",
  max: "when reached, switches even mid-video. A pause stops it. 0 turns the limit off.",
  maxScenes: " Scenes and pictures play this long if the minimum is off.",
  // the scene rule in one plain line (separate timing off; docs/decisions.md § "A scene's minimum play time beats its maximum"): the one limit that's set, the minimum if both are
  sceneRule: "Scenes switch at the minimum, or at the maximum if the minimum is off. With both off, a scene stays until you switch.",
  separate: "scenes and still images never end, so they get their own time. The minimum and maximum then apply to videos only.",
  separateOff: "Turn this on to give scenes and still images a time of their own.",
  scenesAfter: "scenes and pictures switch after this",
  // "When the playlist starts again" (plan § Playlist start): what a Play, a boot or a return to the playlist does
  startOver: "sequential starts from the first wallpaper, shuffle shuffles anew",
  startResume: "the same wallpaper, at the same moment",
  startLive: "It takes effect the next time the playlist starts, so what's playing now carries on.",
  // Pause when covered / the Expert "while parked" rule
  cover: "pauses the wallpaper while all its monitors are covered",
  parked: "Keep rotating: the playlist carries on unseen. Hold: its timers stop until a monitor shows the wallpaper again.",
};
