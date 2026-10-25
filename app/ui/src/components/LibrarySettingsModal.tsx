import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { RotateCcw, Copy, Clock, PlayCircle, ExternalLink, Monitor, Shield } from "lucide-react";
import { api, media, still, anim as animUrl, CARD_STILL_W, type LibraryItem } from "../api/client";
import { useStore } from "../store";
import { YouTubeEmbed } from "./YouTubeEmbed";
import { atRest, boxFrame, boxOf, CLOSE, fromSourceClip, fullClip, OPEN, onScreen, onSource, sourceEl, type Box, type MorphSource } from "./morph";

const VIDEO_RE = /\.(mp4|webm|mov|mkv|avi)$/i;
const MEDIA_RADIUS = 14;

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
    // defer past the open-morph: its setState re-render re-projects framer's layout nodes → jank
    const t = setTimeout(() => { api.duration(item.videoPath).then((r) => alive && setDur(fmtDur(r.seconds))).catch(() => {}); }, 380);
    return () => { alive = false; clearTimeout(t); };
  }, [item]);

  // ---- the morph ------------------------------------------------------------------------------
  const panelRef = useRef<HTMLDivElement>(null);
  const mediaRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const closingRef = useRef(false);
  const flightRef = useRef(0); // the newest flight; an older one's finish must not tidy up after a newer one
  // the picture's own aspect: the card's still knows it at the click; else 16:9 until the image loads
  const [loaded, setLoaded] = useState<{ path: string; aspect: number } | null>(null);
  const aspect = source?.aspect ?? (loaded && loaded.path === item?.videoPath ? loaded.aspect : 16 / 9);
  const [fullFor, setFullFor] = useState<string | null>(null); // the sharp layer shows once IT loaded

  // media box: card crop → its place (uniform scale + re-crop); ghost: card → panel; body fades in late.
  const fly = (src: HTMLElement, S: Box, dir: "open" | "close"): Animation[] => {
    const panel = panelRef.current!, mediaEl = mediaRef.current!, ghost = ghostRef.current!, body = bodyRef.current!;
    for (const el of [panel, mediaEl, ghost, body]) el.getAnimations().forEach((a) => a.cancel());
    delete panel.dataset.morph;
    const P = boxOf(panel), M = boxOf(mediaEl), B = boxOf(body);
    const pcs = getComputedStyle(panel);
    const rs = parseFloat(getComputedStyle(src).borderTopLeftRadius) || 8;
    const rp = parseFloat(pcs.borderTopLeftRadius) || 16;
    Object.assign(ghost.style, { display: "block", background: pcs.backgroundColor, border: pcs.border, boxShadow: pcs.boxShadow });
    panel.dataset.morph = "1";
    const flight = ++flightRef.current;
    const opt = { ...(dir === "open" ? OPEN : CLOSE), fill: "both" as FillMode };
    const way = (k: Keyframe[]) => (dir === "open" ? k : [...k].reverse());
    const anims = [
      mediaEl.animate(way([onSource(M, S, rs, aspect), atRest(MEDIA_RADIUS)]), opt),
      ghost.animate(way([boxFrame(S, rs), boxFrame(P, rp)]), opt),
      // the body stays inside the growing ghost (its own clip, same easing) and fades in late / out early
      body.animate(way([fromSourceClip(B, S), fullClip(B)]), opt),
      body.animate(dir === "open" ? [{ opacity: 0 }, { opacity: 0, offset: 0.35 }, { opacity: 1 }] : [{ opacity: 1 }, { opacity: 0, offset: 0.35 }, { opacity: 0 }], opt),
    ];
    if (dir === "open")
      anims[0].finished.then(() => {
        if (flight !== flightRef.current) return;
        delete panel.dataset.morph; ghost.style.display = "none";
        anims.forEach((a) => a.cancel());
      }, () => {});
    return anims;
  };

  useLayoutEffect(() => {
    if (!item) return;
    closingRef.current = false;
    const src = sourceEl(morphId);
    const S = src ? boxOf(src) : null;
    if (!src || !S || !onScreen(S) || !panelRef.current) {
      panelRef.current?.animate([{ opacity: 0, transform: "scale(0.97)" }, { opacity: 1, transform: "scale(1)" }], { duration: 200, easing: "ease-out" });
      return;
    }
    const anims = fly(src, S, "open");
    return () => anims.forEach((a) => a.cancel());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item]);

  // back into the source — wherever it is NOW (the strip may have scrolled); gone/offscreen → fade out
  const requestClose = () => {
    if (closingRef.current) return;
    closingRef.current = true;
    const src = sourceEl(morphId);
    const S = src ? boxOf(src) : null;
    const panel = panelRef.current;
    if (!panel || !src || !S || !onScreen(S)) {
      if (!panel) { onClose(); return; }
      panel.animate([{ opacity: 1, transform: "scale(1)" }, { opacity: 0, transform: "scale(0.97)" }], { duration: 160, easing: "ease-in", fill: "both" })
        .finished.then(onClose, onClose);
      return;
    }
    fly(src, S, "close")[0].finished.then(onClose, onClose);
  };
  const closeRef = useRef(requestClose);
  useEffect(() => { closeRef.current = requestClose; });
  useEffect(() => {
    if (!item) return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") closeRef.current(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [item]);

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
  // restart), or the video from where the card's hover video was
  const stillSrc = item.thumbnailPath || item.animatedThumbnailPath;
  const baseSrc = stillSrc ? still(stillSrc, CARD_STILL_W) : "";
  const fullSrc = item.thumbnailPath && !/\.(gif|webp)$/i.test(item.thumbnailPath) ? media(item.thumbnailPath) : stillSrc ? still(stillSrc) : "";
  const anim = item.animatedThumbnailPath;
  const gifSrc = anim && !VIDEO_RE.test(anim) ? animUrl(anim) : null;
  const vidSrc = item.isScene ? null : anim && VIDEO_RE.test(anim) ? media(anim) : !anim && VIDEO_RE.test(item.videoPath) ? media(item.videoPath) : null;

  return (
    <div className="modal-backdrop" onClick={requestClose}>
      {/* panel-coloured layer that grows card → panel (and back) while the panel itself is see-through */}
      <div className="morph-ghost" ref={ghostRef} />
      <div className="modal lib-settings" ref={panelRef} onClick={(e) => e.stopPropagation()}>
        <div className="lib-stage">
          <div className="morph-media" data-morph-media ref={mediaRef}
            style={{ aspectRatio: String(aspect), width: `min(100%, calc(62vh * ${aspect}))` }}>
            {baseSrc && <img src={baseSrc} alt="" />}
            {fullSrc && <img className={`mm-full${fullFor === fullSrc ? " on" : ""}`} src={fullSrc} alt=""
              onLoad={(e) => { const i = e.currentTarget; if (i.naturalWidth) setLoaded({ path: item.videoPath, aspect: i.naturalWidth / i.naturalHeight }); setFullFor(fullSrc); }} />}
            {gifSrc && <img className="mm-anim" src={gifSrc} alt="" />}
            {!gifSrc && vidSrc && <video className="mm-anim" src={vidSrc} muted loop autoPlay playsInline
              onLoadedMetadata={(e) => { if (source?.videoTime) e.currentTarget.currentTime = source.videoTime; }} />}
          </div>
          {ytPlaying && item.youtubeUrl && <YouTubeEmbed url={item.youtubeUrl} onClose={() => setYtPlaying(false)} />}
        </div>
        <div className="modal-body" ref={bodyRef}>
          <h2>{item.title}{multi && <span className="shint"> · applies to {targets.length} selected</span>}</h2>
          <div className="meta">
            {dur && <span className="mrow"><Clock size={14} /> {dur}</span>}
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
          {/* scenes always render at 1× (linux-wallpaperengine has no speed control) → hide the no-op slider */}
          {!item.isScene && (
            <div className="srow"><div className="slabel">Speed {spdOv ? "" : "(global)"}<span className="shint">{spd}×</span></div>
              <div className="sctl"><input type="range" min={0.1} max={4} step={0.1} value={spd} onChange={(e) => setSpeed(+e.target.value)} />
                {spdOv && <button className="mini ico" onClick={resetSpeed}><RotateCcw size={13} /> Global</button>}</div></div>
          )}
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
        </div>
      </div>
    </div>
  );
}
