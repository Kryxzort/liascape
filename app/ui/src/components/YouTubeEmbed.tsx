import { useEffect, useRef, useState } from "react";

// Shared between the Browse and the Library item sidebars (1:1 — the only fully-duplicate
// bit). Overlays the thumbnail stage with a 16:9 YouTube player (the video's own aspect), centered. The picture's preview
// switch shows it (SidePanel.tsx SideMedia). Unmounting it (a switch, the item changing, the sidebar closing) stops it. No
// close button of its own: the preview switch above the picture leaves it like any other preview. It LOOPS
// like the other previews, and WE loop it (docs/decisions.md § "Loop trailers on the player's "ended", not YouTube's
// `loop=1`"): when the player reports it ended (state 0 — `onStateChange` / `infoDelivery.playerState`), we send
// `seekTo(0)` + `playVideo`. YouTube's own loop (`loop=1&playlist=<its id>`, a one-item playlist) restarts it before its
// real end. `data-yt-loops` counts our restarts (the probe's hook).
//
// Its mute state and volume are REMEMBERED: muted by default — the desktop's wallpaper owns the sound — and after that whatever the player's own button was
// last set to, across trailers and restarts (localStorage `liascape_yt_muted`). The player reports it through YouTube's
// embed messaging (`enablejsapi=1`, the channel its IFrame Player API uses): once the iframe loads we post `listening`,
// and it answers with `infoDelivery` messages carrying `info.muted` whenever it changes. Only messages from THIS iframe
// (`event.source`) and from youtube.com count. The next trailer opens with `mute=0|1`; the volume has no URL parameter, so
// it's a `setVolume` command once the player answers — and the player's FIRST reports (its default 100, before that
// command lands) are ignored until the saved level shows up in one (`applied`), or they'd overwrite it every time.
// localStorage `liascape_yt_volume` (0–100; absent = the player's own default).
const ytId = (u: string) => u.match(/(?:v=|youtu\.be\/|embed\/)([A-Za-z0-9_-]{11})/)?.[1] ?? null;
const KEY = "liascape_yt_muted", VKEY = "liascape_yt_volume";
const ytMutedPref = () => localStorage.getItem(KEY) !== "0";
const ytVolumePref = (): number | null => { const v = Number(localStorage.getItem(VKEY)); return localStorage.getItem(VKEY) != null && Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : null; };
const post = (w: Window | null | undefined, msg: object) => w?.postMessage(JSON.stringify(msg), "*");
const YT_ORIGINS = new Set(["https://www.youtube.com", "https://www.youtube-nocookie.com"]);

export function YouTubeEmbed({ url }: { url: string }) {
  const id = ytId(url);
  const frame = useRef<HTMLIFrameElement>(null);
  const [muted] = useState(ytMutedPref); // read once per embed: the src must not change while it plays
  const [volume] = useState(ytVolumePref);
  useEffect(() => {
    let applied = volume == null, tries = 0; // nothing saved → the player's own reports are the truth from the start
    const onMsg = (e: MessageEvent) => {
      if (!YT_ORIGINS.has(e.origin) || e.source !== frame.current?.contentWindow) return;
      let d: unknown = e.data;
      if (typeof d === "string") { try { d = JSON.parse(d); } catch { return; } }
      const msg = d as { event?: string; info?: unknown } | null;
      const ended = (msg?.event === "onStateChange" && msg.info === 0) || (msg?.event === "infoDelivery" && (msg.info as { playerState?: unknown } | null)?.playerState === 0);
      if (ended) {
        const w = frame.current?.contentWindow;
        post(w, { event: "command", func: "seekTo", args: [0, true] }); post(w, { event: "command", func: "playVideo", args: [] });
        const st = frame.current?.parentElement; if (st) st.dataset.ytLoops = String(Number(st.dataset.ytLoops ?? 0) + 1);
      }
      const info = (msg?.event === "infoDelivery" ? msg.info : null) as { muted?: unknown; volume?: unknown } | null;
      if (!info) return;
      if (!applied) {
        // the player is up: give it the saved volume, and trust its reports once they carry it
        // (it reports several times a second while playing: 10 tries, then its reports count anyway — never a loop)
        if ((typeof info.volume === "number" && Math.round(info.volume) === Math.round(volume!)) || ++tries > 10) applied = true;
        else { post(frame.current?.contentWindow, { event: "command", func: "setVolume", args: [volume] }); return; }
      }
      if (typeof info.muted === "boolean") localStorage.setItem(KEY, info.muted ? "1" : "0");
      if (typeof info.volume === "number") localStorage.setItem(VKEY, String(Math.round(info.volume)));
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [volume]);
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
