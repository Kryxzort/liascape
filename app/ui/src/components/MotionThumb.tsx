import { useEffect, useRef } from "react";
import { media, clip, still, anim as animUrl, CARD_STILL_W, type LibraryItem } from "../api/client";
import { useStore } from "../store";
import { previewVideo } from "./mediaAssets";

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
// needed. PERF: the parent card has content-visibility:auto, so offscreen cards never mount the
// animated layer at all.
// `hover`: the pointer is on it. `autoGif`: AutoPlayGifs is on for this item (it has a gif). `autoVideo`: "Play video
// previews" plays it now (useAutoplayVideo). `videoOverGif`: "Prefer video previews" — an item with a gif AND its own
// video previews with the video; its gif then only animates in bulk (under the hovered video, so it never restarts) and
// goes once the video plays by itself (two decodes of one picture).
export function MotionThumb({ item, hover, autoGif, autoVideo = false, videoOverGif = false }:
  { item: LibraryItem; hover: boolean; autoGif: boolean; autoVideo?: boolean; videoOverGif?: boolean }) {
  const anim = item.animatedThumbnailPath;
  const vid = previewVideo(item, videoOverGif);
  const gif = !!anim && anim !== vid;
  const playVideo = !!vid && (hover || autoVideo);
  // with "Play video previews" on, a hover plays the same clip as the bulk preview: a card hovered before it is seen
  // on screen doesn't start the full file only to swap it for the clip a moment later
  const clips = useStore((s) => !!s.settings?.autoPlayVideoThumbs);
  const showGif = gif && (vid ? autoGif && !autoVideo : hover || autoGif);
  // When the only sibling image is the preview
  // gif/webp, thumbnailPath IS that gif — still() extracts a frozen frame so the STATIC layer doesn't
  // animate regardless of AutoPlayGifs. Plain jpg/png pass straight through to /media. When there's no
  // static thumbnail at all (gif-only items / dangling we_thumbs links), extract the still from the gif.
  const stillSrc = item.thumbnailPath || item.animatedThumbnailPath;
  const staticSrc = stillSrc ? still(stillSrc, CARD_STILL_W) : "";
  return (
    <>
      <img className="thumb" src={staticSrc} loading="lazy" decoding="async" alt="" />
      {showGif && (
        // gif → /anim (leading-black trimmed); backgroundImage = the /still frame so the loop-gap
        // shows a real frame, not black (parity with the Browse Card).
        <img className="thumb anim" src={animUrl(anim!)} decoding="async" alt=""
          style={{ backgroundImage: `url("${staticSrc}")`, backgroundSize: "cover", backgroundPosition: "center" }} />
      )}
      {playVideo && (clips || autoVideo
        // PERF: "Play video previews" plays every one on screen, so each plays a small clip (/clip, the backend's
        // MakeClip), never the full file: a full-size video holds one of Chromium's 6 connections to the backend while
        // it plays and decodes 1080p-4K frames. Without it, a lone hover plays the real video.
        ? <PreviewVideo key="clip" src={clip(vid!)} preload="auto" />
        // a preview asset is small (its metadata is cheap); the wallpaper's own video loads nothing until it plays
        : <PreviewVideo key="full" src={media(vid!)} preload={vid === anim ? "metadata" : "none"} />
      )}
    </>
  );
}
