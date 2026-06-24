import { useEffect, useMemo, useRef } from "react";
import { useStore } from "../store";
import { media, api } from "../api/client";

// LIVE wallpaper played behind the UI (position:fixed, z-index 0). The playing video if it's a video;
// when the wallpaper changes to a SCENE (no playable video) keep the last shown; nothing ever played →
// a random library video. Synced to the live mpv position, PAUSED when backgrounded (appActive), and
// re-synced the instant it refocuses. A wallpaper change SWAPS the src in place (no crossfade) — same
// as the desktop, which swaps instantly (mpv `loadfile` in timed/advance modes, or a restart in others).
export function WallpaperBg() {
  const playingPath = useStore((s) => s.playingPath);
  const libraryItems = useStore((s) => s.libraryItems);
  const appActive = useStore((s) => s.appActive);
  const videoScale = useStore((s) => (s.settings?.videoScale as string) ?? "fill");
  const globalSpeed = useStore((s) => (s.settings?.speed as number) ?? 1);

  const isVid = (p: string) => /\.(mp4|webm|mov|mkv|avi)$/i.test(p);
  const playingVideo = playingPath && isVid(playingPath) ? playingPath : null;
  const randomVideo = useMemo(() => {
    const vids = libraryItems.filter((i) => !i.isScene && isVid(i.videoPath));
    return vids.length ? vids[Math.floor(Math.random() * vids.length)].videoPath : null;
  }, [libraryItems]);
  const lastRef = useRef<string | null>(null);
  if (playingVideo) lastRef.current = playingVideo;
  const bgPath = playingVideo ?? lastRef.current ?? randomVideo;
  const bgVideo = bgPath ? media(bgPath) : null;
  const fit = videoScale === "fill" ? "cover" : "contain";

  const ref = useRef<HTMLVideoElement>(null);
  const syncLive = !!playingVideo && bgPath === playingVideo;
  // mirror the playing wallpaper's SPEED (effective = per-item override ?? global) so a 2× wallpaper's
  // bg doesn't crawl at 1× and stutter on each position-resync. Decorative (stale/random) bg → 1×.
  const playingItem = useMemo(() => libraryItems.find((i) => i.videoPath === playingPath), [libraryItems, playingPath]);
  const effSpeed = syncLive ? (playingItem?.speedOverride ?? globalSpeed) : 1;
  // seek the preview to the live mpv position (only meaningful when the preview IS the playing video)
  const syncNow = () => {
    const v = ref.current;
    if (!v || !syncLive || !appActive) return;
    api.current().then((c) => {
      const vv = ref.current;
      if (!vv || c.path !== playingVideo || c.position == null || !vv.duration) return;
      const target = c.position % vv.duration;
      if (Math.abs(vv.currentTime - target) > 0.3) vv.currentTime = target;
    }).catch(() => {});
  };
  useEffect(() => {
    if (!syncLive || !appActive) return;
    const id = setInterval(syncNow, 2000);
    return () => clearInterval(id);
  }, [syncLive, playingVideo, appActive]); // eslint-disable-line
  // pause when backgrounded; on REFOCUS resume AND re-sync immediately. The paused preview fell behind
  // the live mpv position while away — seek right away, and AGAIN once it's actually playing (the first
  // seek can land before the just-resumed video is ready), so it snaps in-sync without the 1-2s wait.
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (!appActive) { v.pause(); return; }
    v.play().catch(() => {});
    syncNow();
    const onPlaying = () => { syncNow(); v.removeEventListener("playing", onPlaying); };
    v.addEventListener("playing", onPlaying);
    return () => v.removeEventListener("playing", onPlaying);
  }, [appActive, bgVideo]); // eslint-disable-line

  // keep playbackRate in lockstep with the live speed (override or global change applies instantly,
  // no reload) — and re-assert after a src swap, which can reset the rate to 1.
  useEffect(() => { const v = ref.current; if (v) v.playbackRate = effSpeed; }, [effSpeed, bgVideo]);

  // single persistent element — changing `src` swaps the video in place (instant), the [bgVideo] effect
  // above re-plays + re-syncs on the swap. No key/remount, no crossfade.
  if (!bgVideo) return null;
  return <video ref={ref} className="settings-bg" style={{ objectFit: fit }}
    src={bgVideo} autoPlay muted loop playsInline onLoadedMetadata={syncNow} />;
}
