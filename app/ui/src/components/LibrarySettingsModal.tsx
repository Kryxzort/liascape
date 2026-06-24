import { useEffect, useReducer, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { RotateCcw, Copy, Clock, PlayCircle, ExternalLink, Monitor, Shield } from "lucide-react";
import { api, media, still, CARD_STILL_W, type LibraryItem } from "../api/client";
import { useStore } from "../store";
import { YouTubeEmbed } from "./YouTubeEmbed";

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
export function LibrarySettingsModal({
  item, siblings, morphId, globalVolume, globalSpeed, onClose,
}: { item: LibraryItem | null; siblings: LibraryItem[]; morphId: string | null; globalVolume: number; globalSpeed: number; onClose: () => void }) {
  const [vol, setVol] = useState(0);
  const [spd, setSpd] = useState(1);
  const [volOv, setVolOv] = useState(false);
  const [spdOv, setSpdOv] = useState(false);
  const [wl, setWl] = useState(false);
  const [dur, setDur] = useState("");
  const [ytPlaying, setYtPlaying] = useState(false);
  const patchItem = useStore((s) => s.patchLibraryItem);
  const playingPath = useStore((s) => s.playingPath);
  // drag tuning: live-preview the desktop throttled (cheap IPC), persist once after the drag settles.
  const prevRef = useRef<{ vol: number | null; spd: number | null; last: number; tm: number | null }>({ vol: null, spd: null, last: 0, tm: null });
  const persistRef = useRef<{ tm: number | null; fn: (() => void) | null }>({ tm: null, fn: null });
  // flush a pending persist on unmount so a quick drag-then-close still saves the final value
  useEffect(() => () => { const d = persistRef.current; if (d.tm != null) { clearTimeout(d.tm); d.fn?.(); d.tm = null; d.fn = null; } }, []);

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

  // kick framer to run the card→modal layoutId morph on the frame after open (see PreviewModal).
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => { if (item) { const r = requestAnimationFrame(() => force()); return () => cancelAnimationFrame(r); } }, [item]);

  if (!item) return null;
  const p = item.videoPath;
  // apply to every selected sibling (or just this card).
  const targets = (siblings.length ? siblings : [item]).map((i) => i.videoPath);
  const multi = targets.length > 1;
  const playingTargeted = !!playingPath && targets.includes(playingPath);
  // throttled live preview (~90ms, trailing) — only meaningful when the edited item is what's playing.
  const flushPreview = () => {
    const r = prevRef.current; const body: { volume?: number; speed?: number } = {};
    if (r.vol != null) { body.volume = r.vol; r.vol = null; }
    if (r.spd != null) { body.speed = r.spd; r.spd = null; }
    r.last = Date.now(); r.tm = null;
    if (body.volume != null || body.speed != null) api.preview(body);
  };
  const queuePreview = (patch: { volume?: number; speed?: number }) => {
    if (!playingTargeted) return;
    const r = prevRef.current;
    if (patch.volume != null) r.vol = patch.volume;
    if (patch.speed != null) r.spd = patch.speed;
    const dt = Date.now() - r.last;
    if (dt >= 90) flushPreview();
    else if (r.tm == null) r.tm = window.setTimeout(flushPreview, 90 - dt);
  };
  // persist once, 250ms after the last drag tick (one index write, not ~60)
  const queuePersist = (fn: () => void) => {
    const d = persistRef.current;
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
    queuePersist(() => targets.forEach((t) => api.libraryVolume(t, v)));
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
    queuePersist(() => targets.forEach((t) => api.librarySpeed(t, v)));
  };
  const resetSpeed = () => {
    setSpdOv(false); setSpd(globalSpeed);
    targets.forEach((t) => { patchItem(t, { speedOverride: null }); api.librarySpeed(t, null); });
    queuePreview({ speed: globalSpeed });
  };
  const toggleWl = (b: boolean) => { setWl(b); api.libraryWhitelist(p, b); };

  return (
    <AnimatePresence>
      {item && (
        <motion.div className="modal-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
          {/* plain panel (no animating wrapper) so the layoutId image's enter morph projects cleanly */}
          <div className="modal lib-settings" onClick={(e) => e.stopPropagation()}>
            {/* show the thumbnail at its OWN natural aspect (square for most WE previews) — not cropped to 16/9 */}
            <div className="lib-stage">
              {/* morph anchor: SAME src the library card uses (still @ card width) → framer morphs the
                  identical cached image from the thumbnail (not a mismatched one flying in from the side) */}
              <motion.img layoutId={morphId ?? `lib-${item.videoPath}`} className="modal-img natural"
                src={still(item.thumbnailPath ?? item.animatedThumbnailPath ?? "", CARD_STILL_W)} alt="" style={{ borderRadius: 14 }} />
              {/* native-res layer over the morph anchor so the enlarged view stays sharp (like Browse) */}
              {item.thumbnailPath && <img className="modal-img natural layer" src={media(item.thumbnailPath)} alt="" />}
              {ytPlaying && item.youtubeUrl && <YouTubeEmbed url={item.youtubeUrl} onClose={() => setYtPlaying(false)} />}
            </div>
            <motion.div className="modal-body" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.08, duration: 0.2 }}>
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
                <button className="btn ghost" onClick={onClose}>Close</button>
              </div>
            </motion.div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
