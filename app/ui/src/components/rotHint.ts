// the rotation rows' hints (Settings → Rotation and the playlist modal). Every limit: 0 = off. `min` / `max` get the
// scene clause only while "Separate timing for scenes" is off (on, scenes + still images have their own row).
export const ROT_HINT = {
  every: "a plain timer — switches even mid-video",
  min: "play at least this long, then switch at the next video end — a shorter video loops until then (never cut mid-loop) · 0 = off: switch at every end, however short",
  minScenes: " · a scene switches after this (it never ends), even when the maximum is shorter · a still image shows this long",
  max: "switch at this point even mid-video · wall-clock (speed doesn't stretch it), a pause stops it · 0 = off: a video plays to its end, however long",
  maxScenes: " · a scene uses it only while the minimum is off",
  // the scene rule in one plain line (separate timing off; docs/decisions.md § "A scene's minimum play time beats its maximum"): the one limit that's set, the minimum if both are
  sceneRule: "Scenes: they switch at the minimum — or at the maximum if the minimum is off. Both off: a scene stays until you switch.",
  separate: "scenes and still images never end — give them their own time; the minimum / maximum then apply to videos only",
  separateOff: "Turn this on to give scenes and still images a time of their own (the minimum / maximum then apply to videos only).",
  scenesAfter: "a scene or still image switches after this · 0 = off: it stays until you switch",
  // "When the playlist starts again" (plan § Playlist start): what a Play, a boot or a return to the playlist does
  startOver: "Sequential starts from the first wallpaper, shuffle shuffles anew",
  startResume: "The same wallpaper, at the same moment",
  startLive: "Takes effect the next time the playlist starts — what's playing now carries on",
  // Pause when covered / the Expert "while parked" rule
  cover: "Pauses picture and sound while every monitor showing the wallpaper is covered",
  parked: "Keep rotating: the playlist carries on unseen, as it always did · Hold: its timers stop until a monitor shows the wallpaper again",
};
