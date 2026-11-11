import { useEffect, useRef, useState } from "react";
import { RotateCcw, Clock, ExternalLink, Monitor, Shield, AudioLines, Play, FolderOpen, Trash2, CloudOff, AlertTriangle, SlidersHorizontal, Hash, Check } from "lucide-react";
import { api, media, still, anim as animUrl, CARD_STILL_W, type LibraryItem } from "../api/client";
import { useStore } from "../store";
import { levelOf, rank, type Level } from "../settingsLevel";
import { SideMedia, SideHeadTools, SideSection } from "./SidePanel";
import { usePreview, rangeFill } from "./sidePreview";
import { PlaylistToggle } from "./PlaylistToggle";
import { ScenePropsEditor } from "./ScenePropsEditor";
import { scenePropsCache } from "./scenePropsCache";

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

// A scene's loudness line (liascape-player; library.md § Loudness): "≈ −14.6 LUFS (estimated)" — the offline estimate
// of its current properties' sound, not played that way yet — or "−15.2 LUFS (measured, 30 min)" (its own measurement
// over that much audible play). null = nothing known (a silent scene, never estimated).
function sceneLoudnessText(i: LibraryItem): string | null {
  if (i.loudnessLufs == null) return null;
  const v = (i.loudnessLufs < 0 ? "−" : "") + Math.abs(i.loudnessLufs).toFixed(1) + " LUFS";
  if (i.loudnessEstimated) return `≈ ${v} (estimated)`;
  const s = i.loudnessSeconds ?? 0;
  return s > 0 ? `${v} (measured, ${s < 60 ? `${Math.round(s)} s` : `${Math.round(s / 60)} min`})` : `${v} (measured)`;
}

// the body waits at most this long for its asynchronous sections (a scene's properties) before it shows what it has
const READY_CAP_MS = 450;

// The Library sidebar's content (components/SidePanel.tsx is the shell): everything the per-card settings modal had —
// volume / speed (drag-preview live, persist on release), the scene's properties, its loudness line, the crash
// whitelist, the trailer (the picture's preview switch), Workshop / Steam — plus the old right-click menu's actions (Open in
// file manager, Delete, Delete from source) as tiles, Play (the picture itself — owner 2026-11-11: the Play / In playlist row
// was "redundant clutter") and the playlist toggle (in the head). Mounted per item (`key` = its path, SidePanel): its state is
// that item's.
// `item` is the store's live copy (a `library-item-changed` hands a new one — the values follow, nothing replays);
// `targets` = the multi-selection it's part of (volume / speed / delete repeat to it), else [item].
export function LibrarySide({
  item, targets, playing, keepCurrent, inPlaylist, showDeleteFromSource, globalVolume, globalSpeed,
  onPlay, onToggle, onReveal, onTrash, onDeleteSource,
}: {
  item: LibraryItem; targets: LibraryItem[]; playing: boolean; keepCurrent: boolean; inPlaylist: boolean; showDeleteFromSource: boolean;
  globalVolume: number; globalSpeed: number;
  onPlay: () => void; onToggle: () => void; onReveal: () => void; onTrash: () => void; onDeleteSource: () => void;
}) {
  const [vol, setVol] = useState(0);
  const [spd, setSpd] = useState(1);
  const [volOv, setVolOv] = useState(false);
  const [spdOv, setSpdOv] = useState(false);
  const [wl, setWl] = useState(false);
  const [dur, setDur] = useState("");
  const patchItem = useStore((s) => s.patchLibraryItem);
  // liascape-player plays a scene at its speed (its animation and its pitch-kept sound — owner decision); legacy's LWE is 1×
  const sceneSpeed = useStore((s) => s.settings?.playerEngine === "liascape-player");
  // Settings levels (settingsLevel.ts): the sidebar's rows follow the level like the Settings page's rows do
  const level = useStore((s) => levelOf(s.settings?.settingsLevel));
  const at = (l: Level) => rank(level) >= rank(l);
  const p = item.videoPath;
  const paths = targets.map((i) => i.videoPath);
  const multi = paths.length > 1;
  const sceneProps = item.isScene && !multi;

  // NO POP-IN: the body shows once its asynchronous sections are in (a scene's properties — cached per path after the
  // first visit), or after READY_CAP_MS; the duration row is reserved, so it needs no wait
  const [ready, setReady] = useState(() => !sceneProps || scenePropsCache.has(p));
  useEffect(() => { if (ready) return; const t = setTimeout(() => setReady(true), READY_CAP_MS); return () => clearTimeout(t); }, [ready]);

  // drag tuning: live-preview the desktop throttled (cheap IPC), persist once after the drag settles.
  const prevRef = useRef<{ vol: number | null; spd: number | null; last: number; tm: number | null }>({ vol: null, spd: null, last: 0, tm: null });
  // one pending persist PER FIELD — a shared one let a speed drag replace a volume drag's save
  const persistRef = useRef<Record<"vol" | "spd", { tm: number | null; fn: (() => void) | null }>>({ vol: { tm: null, fn: null }, spd: { tm: null, fn: null } });
  // flush pending persists on unmount (an item switch remounts this) so a quick drag-then-switch still saves the value
  useEffect(() => () => { for (const d of Object.values(persistRef.current)) if (d.tm != null) { clearTimeout(d.tm); d.fn?.(); d.tm = null; d.fn = null; } }, []);

  // the values follow the store's copy (a volume keybind on this item, a patch from another surface)
  useEffect(() => {
    setVolOv(item.volumeOverride != null); setVol(item.volumeOverride ?? globalVolume);
    setSpdOv(item.speedOverride != null); setSpd(item.speedOverride ?? globalSpeed);
    setWl(item.isWhitelisted);
  }, [item, globalVolume, globalSpeed]);

  // per item (this component is keyed by the path): the duration, read at once — nothing flies any more
  useEffect(() => {
    if (item.isScene) return;
    let alive = true;
    api.duration(p).then((r) => alive && setDur(fmtDur(r.seconds))).catch(() => {});
    return () => { alive = false; };
  }, [p]); // eslint-disable-line react-hooks/exhaustive-deps

  // throttled live preview (~90ms, trailing). API: names the edited item(s) — the backend moves exactly their sources,
  // wherever they are, and nothing when none is live. Never "what's playing": mid-transition that's the OTHER wallpaper.
  const flushPreview = () => {
    const r = prevRef.current; const body: { volume?: number; speed?: number; paths: string[] } = { paths };
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
  const setVolume = (v: number) => {
    setVol(v); setVolOv(true);
    paths.forEach((t) => patchItem(t, { volumeOverride: v === globalVolume ? null : v }));
    queuePreview({ volume: v });
    queuePersist("vol", () => paths.forEach((t) => api.libraryVolume(t, v)));
  };
  const resetVolume = () => {
    setVolOv(false); setVol(globalVolume);
    paths.forEach((t) => { patchItem(t, { volumeOverride: null }); api.libraryVolume(t, null); });
    queuePreview({ volume: globalVolume });
  };
  const setSpeed = (v: number) => {
    setSpd(v); setSpdOv(true);
    paths.forEach((t) => patchItem(t, { speedOverride: v === globalSpeed ? null : v }));
    queuePreview({ speed: v });
    queuePersist("spd", () => paths.forEach((t) => api.librarySpeed(t, v)));
  };
  const resetSpeed = () => {
    setSpdOv(false); setSpd(globalSpeed);
    paths.forEach((t) => { patchItem(t, { speedOverride: null }); api.librarySpeed(t, null); });
    queuePreview({ speed: globalSpeed });
  };
  const toggleWl = (b: boolean) => { setWl(b); api.libraryWhitelist(p, b); };

  const stillSrc = item.thumbnailPath || item.animatedThumbnailPath;
  const baseSrc = stillSrc ? still(stillSrc, CARD_STILL_W) : "";
  const fullSrc = item.thumbnailPath && !/\.(gif|webp)$/i.test(item.thumbnailPath) ? media(item.thumbnailPath) : stillSrc ? still(stillSrc) : null;
  const anim = item.animatedThumbnailPath;
  const gifSrc = anim && !VIDEO_RE.test(anim) ? animUrl(anim) : null;
  // the preview switch's "Video": the item's own video file (a scene has none); else a video preview the source shipped
  const vidSrc = item.isScene ? null : VIDEO_RE.test(p) ? media(p) : anim && VIDEO_RE.test(anim) ? media(anim) : null;
  const preview = usePreview("library", { gif: !!gifSrc, video: !!vidSrc, youtube: !!item.youtubeUrl });
  const loud = item.isScene && sceneSpeed ? sceneLoudnessText(item) : null;
  // a row the level hides still shows when this item has its own value for it — hiding never hides a change
  const showSpeed = (!item.isScene || sceneSpeed) && (at("standard") || targets.some((t) => t.speedOverride != null));
  const showLoud = !!loud && at("standard");
  const steam = item.pageUrl ?? (item.workshopId ? `https://steamcommunity.com/sharedfiles/filedetails/?id=${item.workshopId}` : null);
  // keyed by the ID copied, so switching items never carries "Copied" over
  const [copiedId, setCopiedId] = useState<string | null>(null);
  useEffect(() => { if (!copiedId) return; const t = setTimeout(() => setCopiedId(null), 1200); return () => clearTimeout(t); }, [copiedId]);
  const copied = !!item.workshopId && copiedId === item.workshopId;

  return (
    <>
      {/* the head's tools (SidePanel's slot, before close): the playlist toggle — the card's own look — and, while the picture
          shows the trailer (the embed takes the picture's clicks), Play */}
      <SideHeadTools>
        {preview.mode === "youtube" && !playing && (
          <button className="side-tool accent" data-side-play aria-label={`Play ${item.title}`} title="Play it now (Enter)" onClick={onPlay}>
            <Play size={15} fill="currentColor" /></button>
        )}
        <button className={`side-tool side-pl${inPlaylist ? " on" : ""}`} data-side-playlist aria-pressed={inPlaylist}
          aria-label={inPlaylist ? "Remove from playlist" : "Add to playlist"} title={inPlaylist ? "Remove from playlist" : "Add to playlist"}
          onClick={onToggle}><PlaylistToggle on={inPlaylist} /></button>
      </SideHeadTools>
      <SideMedia id={p} cardId={`lib-${p}`} base={baseSrc} full={fullSrc} gif={gifSrc} video={vidSrc} youtube={item.youtubeUrl}
        preview={preview} play={{ label: `Play ${item.title}`, playing, looping: keepCurrent, onPlay }} />
      <div className={`side-body${ready ? "" : " wait"}`}>
        {/* the hero line: what it is (chips) and its numbers (pills) */}
        <div className="side-hero">
          {item.isScene && <span className="side-chip accent">SCENE</span>}
          {item.hasCrashed && <span className="side-chip danger"><AlertTriangle size={12} /> Crashed — won't be played</span>}
          {/* reserved before the duration loads: the rows below don't move when it lands */}
          {!item.isScene && <span className="side-pill" style={{ visibility: dur ? "visible" : "hidden" }}><Clock size={13} /> {dur || "0 seconds"}</span>}
          {item.resolution && <span className="side-pill"><Monitor size={13} /> {item.resolution}</span>}
          {item.ageRating && <span className="side-pill"><Shield size={13} /> {item.ageRating}</span>}
          {/* the Workshop ID: a pill that copies itself (owner 2026-11-11: a "Details" card for one property felt strange) */}
          {item.workshopId && at("standard") && (
            <button className={`side-pill copy${copied ? " done" : ""}`} data-side-row="workshop-id" title="Copy the Workshop ID"
              aria-label={`Workshop ID ${item.workshopId} — copy`}
              onClick={() => { navigator.clipboard?.writeText(item.workshopId!); setCopiedId(item.workshopId!); }}>
              {copied ? <Check size={13} /> : <Hash size={13} />} {copied ? "Copied" : item.workshopId}</button>
          )}
        </div>
        {item.tags && item.tags.length > 0 && (
          <div className="tags side-tags">{item.tags.slice(0, 12).map((t) => <span key={t} className="tag">{t}</span>)}</div>
        )}
        {/* the right-click menu's actions (owner: "all the 4 options from the right click menu"), as tiles */}
        <div className="side-tiles">
          <button className="side-tile" onClick={onReveal}><span className="side-tile-ico"><FolderOpen size={15} /></span>Open in file manager</button>
          {steam && <a className="side-tile" href={steam} target="_blank" rel="noreferrer"><span className="side-tile-ico"><ExternalLink size={15} /></span>Open on Steam</a>}
          <button className="side-tile danger" onClick={onTrash}><span className="side-tile-ico"><Trash2 size={15} /></span>Delete</button>
          {showDeleteFromSource && (
            <button className="side-tile danger" title="Unsubscribe on Steam and delete — Delete from source (unsubscribe)" onClick={onDeleteSource}>
              <span className="side-tile-ico"><CloudOff size={15} /></span>Delete from source</button>
          )}
        </div>
        <SideSection icon={<SlidersHorizontal size={15} />} title="Playback" data-sec="playback">
          {item.hasCrashed && (
            <label className="inline side-wl">
              <input type="checkbox" checked={wl} onChange={(e) => toggleWl(e.target.checked)} /> Keep in playlist despite crash (whitelist)
            </label>
          )}
          <div className="srow" data-side-row="volume"><div className="slabel"><span className="slabel-row">Volume{!volOv && <span className="side-global">global</span>}</span><span className="side-val">{vol}</span></div>
            <div className="sctl"><input type="range" min={0} max={100} value={vol} style={rangeFill(vol, 0, 100)} onChange={(e) => setVolume(+e.target.value)} />
              {volOv && <button className="mini ico" title="Back to the global volume" onClick={resetVolume}><RotateCcw size={13} /> Global</button>}</div></div>
          {/* legacy scenes render at 1× (linux-wallpaperengine has no speed control) → no no-op slider there */}
          {showSpeed && (
            <div className="srow" data-side-row="speed"><div className="slabel"><span className="slabel-row">Speed{!spdOv && <span className="side-global">global</span>}</span><span className="side-val">{spd}×</span></div>
              <div className="sctl"><input type="range" min={0.1} max={4} step={0.1} value={spd} style={rangeFill(spd, 0.1, 4)} onChange={(e) => setSpeed(+e.target.value)} />
                {spdOv && <button className="mini ico" title="Back to the global speed" onClick={resetSpeed}><RotateCcw size={13} /> Global</button>}</div></div>
          )}
          {showLoud && (
            <div className="side-line" data-scene-loudness-line data-side-row="loudness" title="the scene's loudness under its current properties — normalization matches it to the target">
              <AudioLines size={14} /> {loud}</div>
          )}
          {showLoud && item.loudnessEstimated && item.loudnessNote && (
            <div className="shint side-note" data-scene-loudness-note>Estimate may be off: {item.loudnessNote}</div>
          )}
        </SideSection>
        {/* a WE scene's own options (per item — not for a multi-selection: each scene has its own set) */}
        {sceneProps && <ScenePropsEditor key={p} path={p} onReady={() => setReady(true)} />}
      </div>
    </>
  );
}
