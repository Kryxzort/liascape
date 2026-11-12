import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { previewSound, setPreviewMuted, setPreviewVolume } from "./sidePreview";

// Shared between the Browse and the Library item sidebars (1:1 — the only fully-duplicate
// bit). Overlays the thumbnail stage with a 16:9 YouTube player (the video's own aspect), centered. The picture's preview
// switch shows it (SidePanel.tsx SideMedia). Unmounting it (a switch, the item changing, the sidebar closing) stops it. No
// close button of its own: the preview switch above the picture leaves it like any other preview. It LOOPS
// like the other previews, and WE loop it (docs/decisions.md § "Loop trailers on the player's "ended", not YouTube's
// `loop=1`"): when the player reports it ended (state 0 — `onStateChange` / `infoDelivery.playerState`), we send
// `seekTo(0)` + `playVideo`. YouTube's own loop (`loop=1&playlist=<its id>`, a one-item playlist) restarts it before its
// real end. `data-yt-loops` counts our restarts (the probe's hook).
//
// Its mute and volume are the sidebar previews' (sidePreview.ts previewSound, shared with the Video preview's chip and
// slider): `level` is the level it plays at (the item's wallpaper volume until the user sets one), and the player's own
// mute button and volume slider set them. The player reports both through YouTube's
// embed messaging (`enablejsapi=1`, the channel its IFrame Player API uses): once the iframe loads we post `listening`,
// and it answers with `infoDelivery` messages carrying `info.muted` whenever it changes. Only messages from THIS iframe
// (`event.source`) and from youtube.com count. The next trailer opens with `mute=0|1`; the volume has no URL parameter, so
// it's a `setVolume` command once the player answers (and again whenever `level` changes) — and the player's reports
// before that command lands (its default 100) are ignored until the wanted level shows up in one (`applied`), or they'd
// overwrite it every time.
const ytId = (u: string) => u.match(/(?:v=|youtu\.be\/|embed\/)([A-Za-z0-9_-]{11})/)?.[1] ?? null;
const post = (w: Window | null | undefined, msg: object) => w?.postMessage(JSON.stringify(msg), "*");
const YT_ORIGINS = new Set(["https://www.youtube.com", "https://www.youtube-nocookie.com"]);

export function YouTubeEmbed({ url, level }: { url: string; level: number }) {
  const id = ytId(url);
  const frame = useRef<HTMLIFrameElement>(null);
  const [muted] = useState(() => previewSound().muted); // read once per embed: the src must not change while it plays
  // the level the player is told to play at; `sync` re-arms whenever it changes (a new setVolume to confirm)
  const want = useRef(level);
  const sync = useRef({ applied: false, tries: 0 });
  // the player's last reported state was paused (YouTube state 2): a trailer the user paused stays paused when its page
  // shows again (`resume` is taken as the page hides, before our own pause is reported)
  const paused = useRef(false), resume = useRef(true);
  useEffect(() => {
    if (want.current === level) return;
    want.current = level; sync.current = { applied: false, tries: 0 };
    post(frame.current?.contentWindow, { event: "command", func: "setVolume", args: [level] });
  }, [level]);
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (!YT_ORIGINS.has(e.origin) || e.source !== frame.current?.contentWindow) return;
      let d: unknown = e.data;
      if (typeof d === "string") { try { d = JSON.parse(d); } catch { return; } }
      const msg = d as { event?: string; info?: unknown } | null;
      const ended = (msg?.event === "onStateChange" && msg.info === 0) || (msg?.event === "infoDelivery" && (msg.info as { playerState?: unknown } | null)?.playerState === 0);
      const state = msg?.event === "onStateChange" ? msg.info : msg?.event === "infoDelivery" ? (msg.info as { playerState?: unknown } | null)?.playerState : undefined;
      if (typeof state === "number" && state !== -1) paused.current = state === 2;
      if (ended) {
        const w = frame.current?.contentWindow;
        post(w, { event: "command", func: "seekTo", args: [0, true] }); post(w, { event: "command", func: "playVideo", args: [] });
        const st = frame.current?.parentElement; if (st) st.dataset.ytLoops = String(Number(st.dataset.ytLoops ?? 0) + 1);
      }
      const info = (msg?.event === "infoDelivery" ? msg.info : null) as { muted?: unknown; volume?: unknown } | null;
      if (!info) return;
      const sy = sync.current;
      if (!sy.applied) {
        // the player is up: give it the wanted volume, and trust its reports once they carry it
        // (it reports several times a second while playing: 10 tries, then its reports count anyway — never a loop)
        if ((typeof info.volume === "number" && Math.round(info.volume) === want.current) || ++sy.tries > 10) sy.applied = true;
        else { post(frame.current?.contentWindow, { event: "command", func: "setVolume", args: [want.current] }); return; }
      }
      if (typeof info.muted === "boolean") setPreviewMuted(info.muted);
      // a level other than the one it was told: the user moved the player's own slider — the previews' level from now on
      // (`want` first, so the `level` effect doesn't send it back while the user is still dragging)
      if (typeof info.volume === "number" && Math.round(info.volume) !== want.current) { want.current = Math.round(info.volume); setPreviewVolume(info.volume); }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);
  // Paused while its page is hidden (the Library stays mounted behind another tab, App.tsx <Activity>, and a hidden
  // iframe keeps playing its sound); resumed when shown again unless the user had paused it. Activity runs layout-effect
  // cleanups as it hides (before the page is painted hidden) and the effects again as it shows; the first run is the
  // mount (autoplay starts it). The frame's window is taken at setup: a hidden Activity detaches the iframe's ref.
  // Guard: probe-sidebar preview:hiddenTab
  const shownBefore = useRef(false);
  useLayoutEffect(() => {
    const w = frame.current?.contentWindow;
    if (shownBefore.current && resume.current) post(w, { event: "command", func: "playVideo", args: [] });
    shownBefore.current = true;
    return () => { resume.current = !paused.current; post(w, { event: "command", func: "pauseVideo", args: [] }); };
  }, []);
  if (!id) return null;
  const listen = () => post(frame.current?.contentWindow, { event: "listening", id: 1, channel: "widget" });
  const origin = encodeURIComponent(location.origin);
  return (
    <div className="yt-stage" data-preview-layer="youtube" onClick={(e) => e.stopPropagation()}>
      <iframe ref={frame} className="yt-frame" onLoad={listen}
        src={`https://www.youtube.com/embed/${id}?autoplay=1&mute=${muted ? 1 : 0}&rel=0&enablejsapi=1&origin=${origin}`}
        title="YouTube trailer" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowFullScreen />
    </div>
  );
}
