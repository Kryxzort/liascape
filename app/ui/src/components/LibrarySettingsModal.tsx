import { useEffect, useRef, useState } from "react";
import { RotateCcw, Copy, Clock, PlayCircle, ExternalLink, Monitor, Shield } from "lucide-react";
import { api, media, still, anim as animUrl, CARD_STILL_W, type LibraryItem } from "../api/client";
import { useStore } from "../store";
import { YouTubeEmbed } from "./YouTubeEmbed";
import { SETTINGS_MORPH, type MorphSource } from "./morph";
import { useMorph } from "./useMorph";
import { ScenePropsEditor } from "./ScenePropsEditor";

const VIDEO_RE = /\.(mp4|webm|mov|mkv|avi)$/i;

// Duration formatting (e.g. "2 minutes and 3 seconds").
function fmtDur(s: number): string {
  const t = Math.round(s); if (!t) return "";
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
  const parts: string[] = [];
  if (h) parts.push(`${h} ${h === 1 ? "hour" : "hours"}`);
  if (m) parts.push(`${m} ${m === 1 ? "minute" : "minutes"}`);
  if (sec || !parts.length) parts.push(`${sec} ${sec === 1 ? "second" : "seconds"}`);
  return parts.length === 1 ? parts[0] : parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1];
}

// library card "Settings" — per-wallpaper volume/speed overrides (+ ↺ Global),
// whitelist a crashed scene, copy workshop id. Persists via /library/volume|speed|whitelist.
// COOL: morphs out of the surface that opened it (a library card or a strip item) and back into it —
// components/morph.ts; its preview keeps playing (the card's gif, or the video from where the card was).
export function LibrarySettingsModal({
  item, siblings, morphId, source, globalVolume, globalSpeed, onClose,
}: { item: LibraryItem | null; siblings: LibraryItem[]; morphId: string | null; source: MorphSource | null; globalVolume: number; globalSpeed: number; onClose: () => void }) {
  const [vol, setVol] = useState(0);
  const [spd, setSpd] = useState(1);
  const [volOv, setVolOv] = useState(false);
  const [spdOv, setSpdOv] = useState(false);
  const [wl, setWl] = useState(false);
  const [dur, setDur] = useState("");
  const [ytPlaying, setYtPlaying] = useState(false);
  const patchItem = useStore((s) => s.patchLibraryItem);
  // lp-player plays a scene at its speed (its animation and its pitch-kept sound — owner decision); legacy's LWE is 1×
  const sceneSpeed = useStore((s) => s.settings?.playerEngine === "lp-player");
  // drag tuning: live-preview the desktop throttled (cheap IPC), persist once after the drag settles.
  const prevRef = useRef<{ vol: number | null; spd: number | null; last: number; tm: number | null }>({ vol: null, spd: null, last: 0, tm: null });
  // one pending persist PER FIELD — a shared one let a speed drag replace a volume drag's save
  const persistRef = useRef<Record<"vol" | "spd", { tm: number | null; fn: (() => void) | null }>>({ vol: { tm: null, fn: null }, spd: { tm: null, fn: null } });
  // flush pending persists on unmount so a quick drag-then-close still saves the final value
  useEffect(() => () => { for (const d of Object.values(persistRef.current)) if (d.tm != null) { clearTimeout(d.tm); d.fn?.(); d.tm = null; d.fn = null; } }, []);

  useEffect(() => {
    if (!item) return;
    setVolOv(item.volumeOverride != null); setVol(item.volumeOverride ?? globalVolume);
    setSpdOv(item.speedOverride != null); setSpd(item.speedOverride ?? globalSpeed);
    setWl(item.isWhitelisted);
  }, [item, globalVolume, globalSpeed]);

  useEffect(() => { setYtPlaying(false); }, [item]);
  useEffect(() => {
    setDur("");
    if (!item || item.isScene) return;
    let alive = true;
    // defer past the open-morph (a re-render mid-flight can re-lay the panel out)
    const t = setTimeout(() => { api.duration(item.videoPath).then((r) => alive && setDur(fmtDur(r.seconds))).catch(() => {}); }, SETTINGS_MORPH.open.duration + 40);
    return () => { alive = false; clearTimeout(t); };
  }, [item]);

  // ---- the morph (components/useMorph.ts) -----------------------------------------------------------
  // the picture's own aspect: the card's still knows it at the click; else 16:9 until the image loads
  const [loaded, setLoaded] = useState<{ path: string; aspect: number } | null>(null);
  const loadedAspect = loaded && loaded.path === item?.videoPath ? loaded.aspect : null;
  const aspect = source?.aspect ?? loadedAspect ?? 16 / 9;
  const [fullFor, setFullFor] = useState<string | null>(null); // the sharp layer shows once IT loaded
  const [vidOn, setVidOn] = useState<string | null>(null); // the video layer shows once IT plays
  const { panelRef, mediaRef, bodyRef, requestClose, landed } = useMorph({ open: item, ready: (source?.aspect ?? loadedAspect) != null, morphId, aspect, onClose, timing: SETTINGS_MORPH });

  if (!item) return null;
  const p = item.videoPath;
  // apply to every selected sibling (or just this card).
  const targets = (siblings.length ? siblings : [item]).map((i) => i.videoPath);
  const multi = targets.length > 1;
  // throttled live preview (~90ms, trailing). API: names the edited item(s) — the backend moves exactly
  // their sources, wherever they are (on screen, either side of a transition, a pending switch), and
  // nothing when none is live. Never "what's playing": mid-transition that's the OTHER wallpaper.
  const flushPreview = () => {
    const r = prevRef.current; const body: { volume?: number; speed?: number; paths: string[] } = { paths: targets };
    if (r.vol != null) { body.volume = r.vol; r.vol = null; }
    if (r.spd != null) { body.speed = r.spd; r.spd = null; }
    r.last = Date.now(); r.tm = null;
    if (body.volume != null || body.speed != null) api.preview(body);
  };
  const queuePreview = (patch: { volume?: number; speed?: number }) => {
    const r = prevRef.current;
    if (patch.volume != null) r.vol = patch.volume;
    if (patch.speed != null) r.spd = patch.speed;
    const dt = Date.now() - r.last;
    if (dt >= 90) flushPreview();
    else if (r.tm == null) r.tm = window.setTimeout(flushPreview, 90 - dt);
  };
  // persist once, 250ms after the last drag tick (one index write, not ~60)
  const queuePersist = (field: "vol" | "spd", fn: () => void) => {
    const d = persistRef.current[field];
    if (d.tm != null) clearTimeout(d.tm);
    d.fn = fn;
    d.tm = window.setTimeout(() => { d.tm = null; d.fn = null; fn(); }, 250);
  };
  // patch the store too (not just the backend) so the live WallpaperBg + cards reflect it immediately.
  // drag → instant local patch + throttled desktop preview + debounced persist; reset → immediate.
  const setVolume = (v: number) => {
    setVol(v); setVolOv(true);
    targets.forEach((t) => patchItem(t, { volumeOverride: v === globalVolume ? null : v }));
    queuePreview({ volume: v });
    queuePersist("vol", () => targets.forEach((t) => api.libraryVolume(t, v)));
  };
  const resetVolume = () => {
    setVolOv(false); setVol(globalVolume);
    targets.forEach((t) => { patchItem(t, { volumeOverride: null }); api.libraryVolume(t, null); });
    queuePreview({ volume: globalVolume });
  };
  const setSpeed = (v: number) => {
    setSpd(v); setSpdOv(true);
    targets.forEach((t) => patchItem(t, { speedOverride: v === globalSpeed ? null : v }));
    queuePreview({ speed: v });
    queuePersist("spd", () => targets.forEach((t) => api.librarySpeed(t, v)));
  };
  const resetSpeed = () => {
    setSpdOv(false); setSpd(globalSpeed);
    targets.forEach((t) => { patchItem(t, { speedOverride: null }); api.librarySpeed(t, null); });
    queuePreview({ speed: globalSpeed });
  };
  const toggleWl = (b: boolean) => { setWl(b); api.libraryWhitelist(p, b); };

  // the picture, bottom → top: the card's own still (cached: the first frame IS the card) → the sharp
  // native image → the playing preview: the card's gif URL (the same image → the same animation, no
  // restart), or the video from where the card's hover video was (+ the flight).
  // PERF: the sharp image and the video mount once the open flight landed — a full-size decode (the video is
  // often the wallpaper itself, 4K, software-decoded) mid-flight competes with the software-rendered morph
  // for the CPU; the flight shows the card's still (+ its small gif, which keeps the card's animation going)
  const stillSrc = item.thumbnailPath || item.animatedThumbnailPath;
  const baseSrc = stillSrc ? still(stillSrc, CARD_STILL_W) : "";
  const fullSrc = item.thumbnailPath && !/\.(gif|webp)$/i.test(item.thumbnailPath) ? media(item.thumbnailPath) : stillSrc ? still(stillSrc) : "";
  const anim = item.animatedThumbnailPath;
  const gifSrc = anim && !VIDEO_RE.test(anim) ? animUrl(anim) : null;
  const vidSrc = item.isScene ? null : anim && VIDEO_RE.test(anim) ? media(anim) : !anim && VIDEO_RE.test(item.videoPath) ? media(item.videoPath) : null;

  return (
    <div className="modal-backdrop" onClick={requestClose}>
      {/* the panel's chrome is its ::before, which grows card → panel (and back) — components/morph.ts */}
      <div className="modal lib-settings morph-panel" ref={panelRef} onClick={(e) => e.stopPropagation()}>
        <div className="lib-stage">
          <div className="morph-media" data-morph-media ref={mediaRef}
            style={{ aspectRatio: String(aspect), width: `min(100%, calc(62vh * ${aspect}))` }}>
            <div className="morph-pic" data-morph-pic>
            {baseSrc && <img src={baseSrc} alt=""
              onLoad={(e) => { const i = e.currentTarget; if (i.naturalWidth && !loadedAspect) setLoaded({ path: item.videoPath, aspect: i.naturalWidth / i.naturalHeight }); }} />}
            {fullSrc && landed && <img className={`mm-full${fullFor === fullSrc ? " on" : ""}`} src={fullSrc} alt=""
              onLoad={(e) => { const i = e.currentTarget; if (i.naturalWidth) setLoaded({ path: item.videoPath, aspect: i.naturalWidth / i.naturalHeight }); setFullFor(fullSrc); }} />}
            {gifSrc && <img className="mm-anim" src={gifSrc} alt="" />}
            {!gifSrc && vidSrc && landed && <video className={`mm-anim${vidOn === vidSrc ? " on" : ""}`} src={vidSrc} muted loop autoPlay playsInline
              onLoadedMetadata={(e) => { const v = e.currentTarget; if (source?.videoTime != null && v.duration) v.currentTime = (source.videoTime + SETTINGS_MORPH.open.duration / 1000) % v.duration; }}
              onPlaying={() => setVidOn(vidSrc)} />}
            </div>
          </div>
          {ytPlaying && item.youtubeUrl && <YouTubeEmbed url={item.youtubeUrl} onClose={() => setYtPlaying(false)} />}
        </div>
        <div className="morph-clip" ref={bodyRef}><div className="modal-body">
          <h2>{item.title}{multi && <span className="shint"> · applies to {targets.length} selected</span>}</h2>
          <div className="meta">
            {/* its row is reserved before the duration loads: a panel growing mid-morph moves (it's centred)
                and the flight would land off by half the row */}
            {!item.isScene && <span className="mrow" style={{ visibility: dur ? "visible" : "hidden" }}><Clock size={14} /> {dur || "0 seconds"}</span>}
            {item.resolution && <span className="mrow"><Monitor size={14} /> {item.resolution}</span>}
            {item.ageRating && <span className="mrow"><Shield size={14} /> {item.ageRating}</span>}
          </div>
          {item.tags && item.tags.length > 0 && (
            <div className="tags">{item.tags.slice(0, 12).map((t) => <span key={t} className="tag">{t}</span>)}</div>
          )}
          {item.workshopId && (
            <div className="meta"><span>Workshop ID: {item.workshopId}</span>
              <button className="mini ico" title="Copy ID" onClick={() => navigator.clipboard?.writeText(item.workshopId!)}><Copy size={13} /></button></div>
          )}
          {item.hasCrashed && (
            <label className="inline" style={{ marginTop: 10 }}>
              <input type="checkbox" checked={wl} onChange={(e) => toggleWl(e.target.checked)} /> Keep in playlist despite crash (whitelist)
            </label>
          )}
          <div className="srow"><div className="slabel">Volume {volOv ? "" : "(global)"}<span className="shint">{vol}</span></div>
            <div className="sctl"><input type="range" min={0} max={100} value={vol} onChange={(e) => setVolume(+e.target.value)} />
              {volOv && <button className="mini ico" onClick={resetVolume}><RotateCcw size={13} /> Global</button>}</div></div>
          {/* legacy scenes render at 1× (linux-wallpaperengine has no speed control) → hide the no-op slider there */}
          {(!item.isScene || sceneSpeed) && (
            <div className="srow"><div className="slabel">Speed {spdOv ? "" : "(global)"}<span className="shint">{spd}×</span></div>
              <div className="sctl"><input type="range" min={0.1} max={4} step={0.1} value={spd} onChange={(e) => setSpeed(+e.target.value)} />
                {spdOv && <button className="mini ico" onClick={resetSpeed}><RotateCcw size={13} /> Global</button>}</div></div>
          )}
          {/* a WE scene's own options (per item — not for a multi-selection: each scene has its own set) */}
          {item.isScene && !multi && <ScenePropsEditor key={p} path={p} />}
          <div className="modal-actions">
            {item.youtubeUrl && (
              <button className="btn ghost ico" onClick={() => setYtPlaying((p) => !p)}><PlayCircle size={15} /> {ytPlaying ? "Hide trailer" : "Play YouTube"}</button>
            )}
            {(item.pageUrl || item.workshopId) && (
              <a className="btn ghost ico" href={item.pageUrl ?? `https://steamcommunity.com/sharedfiles/filedetails/?id=${item.workshopId}`}
                target="_blank" rel="noreferrer"><ExternalLink size={14} /> Open on Steam</a>
            )}
            <button className="btn ghost" onClick={requestClose}>Close</button>
          </div>
        </div></div>
      </div>
    </div>
  );
}
