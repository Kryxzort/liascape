import { useEffect, useRef, useState } from "react";
import { media, clip, still, anim as animUrl, CARD_STILL_W, type LibraryItem } from "../api/client";
import { useStore } from "../store";
import { previewVideo } from "./mediaAssets";

// PERF: a gif <img> that leaves the document makes its gif restart: once no <img> of it is left, the next garbage
// collection drops the image, and the next <img> fetches it again and plays it from frame 0. So a gif stays mounted once
// it has shown, hidden by `visibility: hidden` when it shouldn't play: Chromium doesn't paint it, so it decodes none of
// its frames (what keeps a backgrounded window's gifs from draining the decode threads, App.tsx appActive), and shown
// again it goes on where its own clock is, as if it had played meanwhile. A hidden one holds ~0.6 MB more than an
// unmounted one (a preview-size gif), so only the KEPT_GIFS last hidden (a hover that ended, the setting turned off)
// stay; older ones unmount. Not while the window is inactive: that hides every gif at once and shows them all again
// when it comes back, so the trim waits until a moment after it does. An exact "where it stopped" needs an
// ImageDecoder-to-canvas clock of our own, measured at twice the renderer CPU of Chromium's own gif animation
// (docs/decisions.md § "Let a hidden gif preview keep its own clock"). Guard: matrix appear:gifResume.
const KEPT_GIFS = 16;
const kept: (() => void)[] = [];
let trimTimer = 0;
function trimKept() {
  trimTimer = 0;
  if (useStore.getState().appActive) while (kept.length > KEPT_GIFS) kept.shift()!();
}
function scheduleTrim() {
  if (kept.length > KEPT_GIFS && !trimTimer) trimTimer = window.setTimeout(trimKept, 1000);
}
useStore.subscribe((s, p) => { if (s.appActive && !p.appActive) scheduleTrim(); });
function keepHidden(drop: () => void): () => void {
  kept.push(drop);
  scheduleTrim();
  return () => { const i = kept.indexOf(drop); if (i >= 0) kept.splice(i, 1); };
}

// PERF: an unmounted <video> doesn't stop loading: Chromium keeps a detached element that still has network activity
// alive, with its decoder and its HTTP connection (one of the 6 to the backend) — a few hovers and scrolls later no
// other video loads at all. Drop the source on the way out, which aborts the load at once. Guard: matrix
// appear:videoThumbs (the scrolled-away videos).
function PreviewVideo({ src, preload }: { src: string; preload: "auto" | "metadata" | "none" }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    return () => { if (v) { v.removeAttribute("src"); v.load(); } };
  }, []);
  return <video ref={ref} className="thumb anim" src={src} muted loop autoPlay playsInline preload={preload} />;
}

// COOL: animated library/playlist preview. Reuses the source's preview gif/webp when present;
// otherwise plays the local wallpaper video on hover (moewalls-type sources ship no gif).
// Browsers autoplay gif/webp <img> and decode off-thread → no special gif decode machinery is
// needed. PERF: the parent card has content-visibility:auto, so offscreen cards never paint the
// animated layer (and Chromium decodes none of its frames).
// `hover`: the pointer is on it. `autoGif`: AutoPlayGifs is on for this item (it has a gif). `autoVideo`: "Play video
// previews" plays it now (useAutoplayVideo). `videoOverGif`: "Use the video instead of the GIF" — an item with a gif AND its own
// video previews with the video; its gif then only animates in bulk (under the hovered video, so it never restarts) and
// goes once the video plays by itself (two decodes of one picture).
export function MotionThumb({ item, hover, autoGif, autoVideo = false, videoOverGif = false }:
  { item: LibraryItem; hover: boolean; autoGif: boolean; autoVideo?: boolean; videoOverGif?: boolean }) {
  const anim = item.animatedThumbnailPath;
  const vid = previewVideo(item, videoOverGif);
  const gif = !!anim && anim !== vid;
  const playVideo = !!vid && (hover || autoVideo);
  // with "Animate wallpapers without a GIF" on, a hover plays the same clip as the bulk preview: a card hovered before it is seen
  // on screen doesn't start the full file only to swap it for the clip a moment later
  const clips = useStore((s) => !!s.settings?.autoPlayVideoThumbs);
  const showGif = gif && (vid ? autoGif && !autoVideo : hover || autoGif);
  // the gif this card has shown (kept mounted, hidden, while it shouldn't play — keepHidden above)
  const [heldGif, setHeldGif] = useState<string | null>(null);
  if (showGif && heldGif !== anim) setHeldGif(anim!);
  const held = gif && heldGif === anim;
  useEffect(() => (held && !showGif ? keepHidden(() => setHeldGif(null)) : undefined), [held, showGif]);
  // When the only sibling image is the preview
  // gif/webp, thumbnailPath IS that gif — still() extracts a frozen frame so the STATIC layer doesn't
  // animate regardless of AutoPlayGifs. Plain jpg/png pass straight through to /media. When there's no
  // static thumbnail at all (gif-only items / dangling we_thumbs links), extract the still from the gif.
  const stillSrc = item.thumbnailPath || item.animatedThumbnailPath;
  const staticSrc = stillSrc ? still(stillSrc, CARD_STILL_W) : "";
  return (
    <>
      <img className="thumb" src={staticSrc} loading="lazy" decoding="async" alt="" />
      {(showGif || held) && (
        // gif → /anim (leading-black trimmed); backgroundImage = the /still frame so the loop-gap
        // shows a real frame, not black (parity with the Browse Card).
        <img className="thumb anim" src={animUrl(anim!)} decoding="async" alt=""
          style={{ backgroundImage: `url("${staticSrc}")`, backgroundSize: "cover", backgroundPosition: "center", visibility: showGif ? undefined : "hidden" }} />
      )}
      {playVideo && (clips || autoVideo
        // PERF: "Animate wallpapers without a GIF" plays every one on screen, so each plays a small clip (/clip, the backend's
        // MakeClip), never the full file: a full-size video holds one of Chromium's 6 connections to the backend while
        // it plays and decodes 1080p-4K frames. Without it, a lone hover plays the real video.
        ? <PreviewVideo key="clip" src={clip(vid!)} preload="auto" />
        // a preview asset is small (its metadata is cheap); the wallpaper's own video loads nothing until it plays
        : <PreviewVideo key="full" src={media(vid!)} preload={vid === anim ? "metadata" : "none"} />
      )}
    </>
  );
}
