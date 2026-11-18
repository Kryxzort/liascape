import { useEffect, useRef, useState } from "react";
import { media, still, anim as animUrl, CARD_STILL_W, type LibraryItem } from "../api/client";
import { useStore } from "../store";
import { firstPreview, hasGifAsset, previewVideo, useGifVideo, useIdleOrderActive, type ThumbKind } from "./mediaAssets";
import { PreviewPlayer } from "./PreviewPlayer";
import { useBoxSize, useClipSrc } from "./clipSource";
import { useAutoplayVideo } from "./autoplay";

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

// COOL: animated library/playlist preview. Reuses the source's preview gif/webp when present;
// otherwise plays the local wallpaper video (moewalls-type sources ship no gif).
// Browsers autoplay gif/webp <img> and decode off-thread → no special gif decode machinery is
// needed. PERF: the parent card has content-visibility:auto, so offscreen cards never paint the
// animated layer (and Chromium decodes none of its frames).
// `hover`: the pointer is on it. `hoverKind` / `idleKind`: what it shows hovered and not (Settings → "On hover" / "Not
// hovered", components/mediaAssets.ts usePreviewKinds). `autoVideo`: unhovered it shows its video and is on screen
// (useAutoplayVideo). Guard: matrix appear:previewOrder, probe-cardpreview cardpv:order.
export function MotionThumb({ item, hover, hoverKind, idleKind, autoVideo = false }:
  { item: LibraryItem; hover: boolean; hoverKind: ThumbKind; idleKind: ThumbKind; autoVideo?: boolean }) {
  const anim = item.animatedThumbnailPath;
  const vid = previewVideo(item);
  const gif = hasGifAsset(item);
  const shown = hover ? hoverKind : idleKind;
  // PERF: unhovered, every video preview on screen plays, so each plays a small clip sized to this box (the static image
  // fills it), never the full file: a full-size video holds one of Chromium's 6 connections to the backend while it plays
  // and decodes 1080p-4K frames (components/clipSource.ts). A hover plays the wallpaper's own file, the hovered card's
  // alone, handed over from the clip at the same moment and back again (components/PreviewPlayer.tsx). The clip is asked
  // for only while "Not hovered" shows the video: nothing else makes one.
  const boxRef = useRef<HTMLImageElement>(null);
  // COOL: Settings → "Play GIF previews as videos": the gif this card would show plays as a clip made from it, the same
  // clips as a video preview's (sized to this box, "Video preview quality", made once and kept: Web/ClipStore.cs). Unlike a
  // gif it can stop on its frame: while the window is inactive (or a hovered video covers it) it holds the frame it shows
  // and goes on from it after, where a gif can only hide (the still shows) and come back elsewhere in its loop. Paused, it
  // decodes nothing. The gif shows until the video's first frame (never an empty card) and comes back at once when the
  // setting goes off: it stays mounted, hidden (keepHidden). On screen only, like any playing preview.
  // Guard: matrix appear:gifVideo.
  const gifVid = useGifVideo(item);
  const active = useStore((s) => s.appActive);
  const idleOrder = useIdleOrderActive();
  const idleOn = firstPreview(idleOrder, { video: !!vid && !item.isScene, gif });
  const gvWant = !!gifVid && (hover ? hoverKind === "gif" || (hoverKind === "video" && idleOn === "gif") : idleOn === "gif");
  const gvSeen = useAutoplayVideo(boxRef, gvWant);
  const [gvShown, setGvShown] = useState(false);
  // a card the inactive window didn't show playing stays as it is (its still) until the window is back
  const gvOn = gvWant && gvSeen && (active || gvShown);
  if (!gvOn && gvShown) setGvShown(false);
  const box = useBoxSize(boxRef, (autoVideo && !!vid) || (gvWant && gvSeen));
  const { src: clipSrc, retry: retryClip } = useClipSrc(autoVideo ? vid : null, box);
  const { src: gvSrc, retry: retryGv } = useClipSrc(gvOn ? gifVid : null, box);
  const realSrc = vid && hover && hoverKind === "video" ? media(vid) : null;
  const videoSrc = realSrc ?? (vid && autoVideo && shown === "video" ? clipSrc : null);
  // a gif that plays unhovered stays shown under the hovered video: it never restarts, and nothing but the gif shows until
  // the video's first frame. It steps aside once its own video shows.
  const showGif = gif && !gvShown && (shown === "gif" || (hover && hoverKind === "video" && idleKind === "gif"));
  // the gif this card has shown (kept mounted, hidden, while it shouldn't play — keepHidden above)
  const [heldGif, setHeldGif] = useState<string | null>(null);
  if (showGif && heldGif !== anim) setHeldGif(anim!);
  const held = gif && heldGif === anim;
  useEffect(() => (held && !showGif ? keepHidden(() => setHeldGif(null)) : undefined), [held, showGif]);
  // When the only sibling image is the preview
  // gif/webp, thumbnailPath IS that gif — still() extracts a frozen frame so the STATIC layer doesn't
  // animate while the gif shouldn't. Plain jpg/png pass straight through to /media. When there's no
  // static thumbnail at all (gif-only items / dangling we_thumbs links), extract the still from the gif.
  const stillSrc = item.thumbnailPath || item.animatedThumbnailPath;
  const staticSrc = stillSrc ? still(stillSrc, CARD_STILL_W) : "";
  return (
    <>
      <img ref={boxRef} className="thumb" src={staticSrc} loading="lazy" decoding="async" alt="" />
      {(showGif || held) && (
        // gif → /anim (leading-black trimmed); backgroundImage = the /still frame so the loop-gap
        // shows a real frame, not black (parity with the Browse Card).
        <img className="thumb anim" src={animUrl(anim!)} decoding="async" alt=""
          style={{ backgroundImage: `url("${staticSrc}")`, backgroundSize: "cover", backgroundPosition: "center", visibility: showGif ? undefined : "hidden" }} />
      )}
      {gvOn && gvSrc && <PreviewPlayer src={gvSrc} real={false} gif paused={!active || !!realSrc} onError={retryGv}
        onShown={() => setGvShown(true)} />}
      {videoSrc && <PreviewPlayer src={videoSrc} real={videoSrc === realSrc} onError={realSrc ? undefined : retryClip} />}
    </>
  );
}
