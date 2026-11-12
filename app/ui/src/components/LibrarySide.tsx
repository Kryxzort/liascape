import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { RotateCcw, Clock, ExternalLink, Monitor, Shield, AudioLines, Trash2, CloudOff, AlertTriangle, SlidersHorizontal, Hash, Check, Repeat } from "lucide-react";
import { api, media, still, anim as animUrl, CARD_STILL_W, type LibraryItem } from "../api/client";
import { useStore } from "../store";
import { levelOf, rank, type Level } from "../settingsLevel";
import { SideMedia, SideSection } from "./SidePanel";
import { FolderFlap } from "./icons";
import { usePreview, rangeFill, useOnline } from "./sidePreview";
import { ScenePropsEditor } from "./ScenePropsEditor";
import { scenePropsCache } from "./scenePropsCache";
import { sideTags } from "./sideTags";
import { useMotion } from "./motion";
import { useLinger } from "../hooks/useLinger";
import { snapFlip, glideFlip } from "./flipGlide";

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

// A scene's loudness line (liascape-player; .claude/rules/backend/library.md § Loudness): "≈ −14.6 LUFS (estimated)" — the offline estimate
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
// the crash notice's (and the whitelist row's) exit: index.css `side-crash-out`
const CRASH_OUT_MS = 220;
// what glides into the room they leave: the body's blocks and the Playback section's rows
const CRASH_FLIP = ":scope > *, .side-sec[data-sec=\"playback\"] > *";

// The Library sidebar's content (components/SidePanel.tsx is the shell): everything the per-card settings modal had —
// volume / speed (drag-preview live, persist on release), the scene's properties, its loudness line, the crash
// whitelist, the trailer (the picture's preview switch), Workshop / Steam — plus the old right-click menu's actions (Open in
// file manager, Delete, Delete from source) as tiles, Play (the picture itself — docs/decisions.md § "Make the sidebar's
// picture the Play control") and the playlist toggle (in the head). Mounted per item (`key` = its path, SidePanel): its state is
// that item's.
// `item` is the store's live copy (a `library-item-changed` hands a new one — the values follow, nothing replays);
// `targets` = the multi-selection it's part of (volume / speed / delete repeat to it), else [item].
export function LibrarySide({
  item, targets, playing, keepCurrent, showDeleteFromSource, globalVolume, globalSpeed,
  onPlay, onReveal, onTrash, onDeleteSource,
}: {
  item: LibraryItem; targets: LibraryItem[]; playing: boolean; keepCurrent: boolean; showDeleteFromSource: boolean;
  globalVolume: number; globalSpeed: number;
  onPlay: () => void; onReveal: () => void; onTrash: () => void; onDeleteSource: () => void;
}) {
  // start from the item's real values — the first paint must not show a 0 volume / 1× speed placeholder
  const [vol, setVol] = useState(() => item.volumeOverride ?? globalVolume);
  const [spd, setSpd] = useState(() => item.speedOverride ?? globalSpeed);
  const [volOv, setVolOv] = useState(() => item.volumeOverride != null);
  const [spdOv, setSpdOv] = useState(() => item.speedOverride != null);
  const [wl, setWl] = useState(() => item.isWhitelisted);
  const [dur, setDur] = useState("");
  const patchItem = useStore((s) => s.patchLibraryItem);
  const openOnSteam = useStore((s) => s.openOnSteam);
  // liascape-player plays a scene at its speed (its animation and its pitch-kept sound, by design); legacy's LWE is 1×
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
  // (adjusted during render on the change, so a keybind's new volume never shows a frame late)
  const [synced, setSynced] = useState({ item, globalVolume, globalSpeed });
  if (synced.item !== item || synced.globalVolume !== globalVolume || synced.globalSpeed !== globalSpeed) {
    setSynced({ item, globalVolume, globalSpeed });
    setVolOv(item.volumeOverride != null); setVol(item.volumeOverride ?? globalVolume);
    setSpdOv(item.speedOverride != null); setSpd(item.speedOverride ?? globalSpeed);
    setWl(item.isWhitelisted);
  }

  // per item (this component is keyed by the path): the duration, read at once — no flight to wait for
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

  // "Clear" on the crash notice: playable again (POST /library/clear-crash; its library-item-changed tells every other page,
  // a new crash marks it again). The notice and the whitelist row fade out (motion off too — never a pop), then what sat
  // after them glides into their room (a FLIP: measured as the fade starts, played back once they unmount).
  // Guard: probe-sidebar lib:clearCrash
  const motion = useMotion();
  const crash = useLinger(item.hasCrashed || null, CRASH_OUT_MS, motion);
  const bodyRef = useRef<HTMLDivElement>(null);
  const flipFrom = useRef<ReturnType<typeof snapFlip>>(null);
  useLayoutEffect(() => { if (crash.closing && motion) flipFrom.current = snapFlip(bodyRef.current, CRASH_FLIP); }, [crash.closing, motion]);
  useLayoutEffect(() => {
    if (crash.value != null || !flipFrom.current) return;
    glideFlip(flipFrom.current, bodyRef.current, CRASH_FLIP); flipFrom.current = null;
  }, [crash.value]);
  const clearCrash = () => {
    patchItem(p, { hasCrashed: false });
    api.libraryClearCrash(p).catch((e) => { patchItem(p, { hasCrashed: true }); useStore.getState().setError(`Couldn't clear the crash mark: ${(e as Error).message}`); });
  };

  const stillSrc = item.thumbnailPath || item.animatedThumbnailPath;
  const baseSrc = stillSrc ? still(stillSrc, CARD_STILL_W) : "";
  const fullSrc = item.thumbnailPath && !/\.(gif|webp)$/i.test(item.thumbnailPath) ? media(item.thumbnailPath) : stillSrc ? still(stillSrc) : null;
  const anim = item.animatedThumbnailPath;
  const gifSrc = anim && !VIDEO_RE.test(anim) ? animUrl(anim) : null;
  // the preview switch's "Video": the item's own video file (a scene has none); else a video preview the source shipped
  const vidSrc = item.isScene ? null : VIDEO_RE.test(p) ? media(p) : anim && VIDEO_RE.test(anim) ? media(anim) : null;
  // the files behind those layers, for "open in your default app": the backend opens a video or a picture, checked by name
  // and content (.claude/rules/backend/api.md § Security); the Picture is the item's still (else its animated preview)
  const local = (f: string | null | undefined) => (f && f.startsWith("/") ? f : null);
  const vidFile = item.isScene ? null : VIDEO_RE.test(p) ? local(p) : anim && VIDEO_RE.test(anim) ? local(anim) : null;
  const files = { video: vidFile, gif: gifSrc ? local(anim) : null, image: local(stillSrc) };
  const online = useOnline();
  const preview = usePreview("library", { gif: !!gifSrc, video: !!vidSrc, youtube: !!item.youtubeUrl && online });
  const loud = item.isScene && sceneSpeed ? sceneLoudnessText(item) : null;
  // the pills below show the resolution and the age rating: their tags would only repeat them
  const tags = sideTags(item.tags, [item.resolution, item.ageRating]);
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
      {/* nothing in the head but close (no playlist toggle there, and no Play either — not even while the
          YouTube trailer covers the picture: play it from the card / Enter, or switch the picture back) */}
      <SideMedia id={p} cardId={`lib-${p}`} base={baseSrc} full={fullSrc} gif={gifSrc} video={vidSrc} youtube={item.youtubeUrl}
        preview={preview} wall={vol} play={{ label: `Play ${item.title}`, playing, looping: keepCurrent, onPlay }} files={files} />
      <div ref={bodyRef} className={`side-body${ready ? "" : " wait"}`}>
        {/* the hero line: what it is (chips) and its numbers (pills) */}
        <div className="side-hero">
          {item.isScene && <span className="side-chip accent">SCENE</span>}
          {/* "keep playing this one" is on — the only thing the old "Playing now" pill said that nothing else does */}
          {playing && keepCurrent && <span className="side-chip accent" data-side-looping><Repeat size={12} /> Looping this one</span>}
          {/* reserved before the duration loads: the rows below don't move when it lands */}
          {!item.isScene && <span className="side-pill" style={{ visibility: dur ? "visible" : "hidden" }}><Clock size={13} /> {dur || "0 seconds"}</span>}
          {item.resolution && <span className="side-pill"><Monitor size={13} /> {item.resolution}</span>}
          {item.ageRating && <span className="side-pill"><Shield size={13} /> {item.ageRating}</span>}
          {/* the Workshop ID: a pill that copies itself (a "Details" card for one property looks odd) */}
          {item.workshopId && at("standard") && (
            <button className={`side-pill copy${copied ? " done" : ""}`} data-side-row="workshop-id" title="Copy the Workshop ID"
              aria-label={`Workshop ID ${item.workshopId} — copy`}
              onClick={() => { navigator.clipboard?.writeText(item.workshopId!); setCopiedId(item.workshopId!); }}>
              {copied ? <Check size={13} className="ico-pop" /> : <Hash size={13} />} {copied ? "Copied" : item.workshopId}</button>
          )}
        </div>
        {tags.length > 0 && <div className="tags side-tags">{tags.map((t) => <span key={t} className="tag">{t}</span>)}</div>}
        {/* the crash mark, as a notice block of the body (the tiles' material, a danger stripe) with its own Clear */}
        {crash.value && (
          <div className={`side-crash${crash.closing ? " leaving" : ""}`} data-side-crash role="status">
            <span className="side-crash-ico"><AlertTriangle size={16} /></span>
            <span className="side-crash-text">This scene crashed the player — it won't be played</span>
            <button className="mini side-crash-clear" data-side-crash-clear aria-label="Clear the crash mark" disabled={crash.closing}
              onClick={clearCrash}>Clear</button>
          </div>
        )}
        {/* the right-click menu's actions (all four of them), as tiles */}
        <div className="side-tiles">
          <button className="side-tile" onClick={onReveal}><span className="side-tile-ico"><FolderFlap size={15} /></span>Open in file manager</button>
          {/* a Workshop item: the Steam CLIENT (POST /steam/open-page; the browser when that couldn't open); else its page link */}
          {item.workshopId ? (
            <button className="side-tile" data-open-steam onClick={() => openOnSteam(item.workshopId!)}><span className="side-tile-ico"><ExternalLink size={15} /></span>Open on Steam</button>
          ) : steam && <a className="side-tile" href={steam} target="_blank" rel="noreferrer"><span className="side-tile-ico"><ExternalLink size={15} /></span>Open on Steam</a>}
          <button className="side-tile danger" onClick={onTrash}><span className="side-tile-ico"><Trash2 size={15} /></span>Delete</button>
          {showDeleteFromSource && (
            <button className="side-tile danger" title="Unsubscribe on Steam and delete — Delete from source (unsubscribe)" onClick={onDeleteSource}>
              <span className="side-tile-ico"><CloudOff size={15} /></span>Delete from source</button>
          )}
        </div>
        <SideSection icon={<SlidersHorizontal size={15} />} title="Playback" data-sec="playback">
          {crash.value && (
            <label className={`inline side-wl${crash.closing ? " leaving" : ""}`}>
              <input type="checkbox" checked={wl} onChange={(e) => toggleWl(e.target.checked)} /> Keep in playlist despite crash (whitelist)
            </label>
          )}
          <div className="srow" data-side-row="volume"><div className="slabel"><span className="slabel-row">Volume{!volOv && <span className="side-global">global</span>}</span><span className="side-val">{vol}</span></div>
            <div className="sctl"><input type="range" min={0} max={100} value={vol} style={rangeFill(vol, 0, 100)} onChange={(e) => setVolume(+e.target.value)} />
              {volOv && <button className="mini ico" onClick={resetVolume}><RotateCcw size={13} /> Global</button>}</div></div>
          {/* legacy scenes render at 1× (linux-wallpaperengine has no speed control) → no no-op slider there */}
          {showSpeed && (
            <div className="srow" data-side-row="speed"><div className="slabel"><span className="slabel-row">Speed{!spdOv && <span className="side-global">global</span>}</span><span className="side-val">{spd}×</span></div>
              <div className="sctl"><input type="range" min={0.1} max={4} step={0.1} value={spd} style={rangeFill(spd, 0.1, 4)} onChange={(e) => setSpeed(+e.target.value)} />
                {spdOv && <button className="mini ico" onClick={resetSpeed}><RotateCcw size={13} /> Global</button>}</div></div>
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
