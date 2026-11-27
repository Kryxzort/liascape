import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { RotateCcw, Clock, ExternalLink, Monitor, Shield, AudioLines, Trash2, CloudOff, CloudDownload, Download, AlertTriangle, SlidersHorizontal,
  Repeat, Unplug, FileWarning, Library as LibraryIcon, Play, X, Info, User, Eye, EyeOff, LoaderCircle } from "lucide-react";
import { api, media, still, thumb, anim as animUrl, steamPageUrl, workshopStub, CARD_STILL_W, type LibraryItem, type OneOffRoute, type Wallpaper } from "../api/client";
import { DOWNLOAD_INCOMPLETE, redownloadAction, unplayableReasonOf, useStore } from "../store";
import { levelOf, rank, type Level } from "../settingsLevel";
import { SideHeadTools, SideMedia, SideSection } from "./SidePanel";
import { FolderFlap } from "./icons";
import { usePreview, rangeFill, useOnline } from "./sidePreview";
import { ScenePropsEditor } from "./ScenePropsEditor";
import { scenePropsCache } from "./scenePropsCache";
import { ageOf, sideTags } from "./sideTags";
import { useMotion, FADE_MS } from "./motion";
import { ContextMenu, type MenuAt, type MenuItem } from "./ContextMenu";
import { keepMenuItem, menuAt, oneOffMenuItem } from "./menuItems";
import { useLinger } from "../hooks/useLinger";
import { WorkshopIdPill } from "./WorkshopIdPill";
import { snapFlip, glideFlip, glideY } from "./flipGlide";
import { BaseRow, CommentsSection, CreatorRow, FavoritePill, PresetsRow, WorkshopStats } from "./WorkshopSocial";
import { SideCooldownNotice } from "./SteamCooldown";
import { actionBlocked, isWorkshopItem } from "./subscribeMode";
import { revealCard } from "../hooks/gridKeys";
import { SizePill, StatPills } from "./sidePills";
import { TypeIcon } from "./TypeIcon";
import { Tip } from "./Tip";
import { magnetRef } from "./magnet";
import { useRemoval } from "./itemRemoval";
import { useWsSubState } from "./wsSubState";

const VIDEO_RE = /\.(mp4|webm|mov|mkv|avi)$/i;
// how long an asked "Download without subscribing" route stays good when nothing it hangs on changed here (a settings change in
// another window moves it)
const ONE_OFF_FRESH_MS = 5000;

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

export type SideHide = { hidden: boolean; n: number; onHide: () => void; onUnhide: () => void };

// THE item sidebar's content, one for the Library and Browse (components/SidePanel.tsx is the shell; docs/decisions.md § "One
// sidebar for an item, the same on both tabs"): the same item shows the same parts, in the same order, with the same actions,
// on either tab. `w` is Browse's card (null in the Library), `lib` the library's copy (the Library's item; in Browse the
// library's copy of the card, else null). Mounted per item (`key` = its path / page URL, SidePanel).
// The one skeleton (each a block of the body; Guard: probe-hidden same:parts):
//   the picture (a click plays the library's copy: docs/decisions.md § "Make the sidebar's picture the Play control"),
//   the info pills, facts only (type, looping, duration, resolution, age, subscribers, favourites as the favourite's toggle,
//   ID, size last), the library copy's notices (crash, can't play),
//   the action area: the library's copy: one split button Play | Unsubscribe (its right-click "Unsubscribe without deleting")
//   or Play | Delete (a Workshop item with auto-import off: its right-click "Delete and unsubscribe"), Subscribe beside it for
//   the library's own copy; else Subscribe and apply / Subscribe (Download for an item that isn't a Workshop result, or one
//   Steam keeps subscribed: then an Unsubscribe too),
//   Made by, Presets (a preset: the scene it uses), About (description + tags), the tiles (Open in file manager, Open on
//   Steam / the page, Hide / Unhide), Playback and Scene properties (the library's copy), Comments.
// Browse's card the library holds gets "Show in Library" under the close button (the head's tools).
// `libTargets` = the library items the edits and the removal repeat to (the multi-selection it's part of, else [lib]);
// `hide` acts on the selection too (`n` cards). No subscription card (being offered Subscribe says it isn't subscribed), no
// line under the buttons.
export function ItemSide({ tab, w, lib, libTargets, hide, clearSel, onRemoved, onShowInBrowse, onShowInLibrary }: {
  tab: "library" | "browse"; w: Wallpaper | null; lib: LibraryItem | null; libTargets: LibraryItem[]; hide: SideHide;
  // the tab's selection emptied once a removal goes ahead; what the tab does once the library's copy is removed
  clearSel: () => void; onRemoved: () => void;
  // the other tab: the creator row's click lists their wallpapers in Browse; "Show in Library" / a preset's base in the Library
  onShowInBrowse: () => void; onShowInLibrary: (path: string) => void;
}) {
  const source = useStore((s) => s.activeSource);
  const globalVolume = useStore((s) => (s.settings?.volume as number) ?? 100);
  const globalSpeed = useStore((s) => (s.settings?.speed as number) ?? 1);
  const playing = useStore((s) => !!lib && s.playingPath === lib.videoPath);
  const keepCurrent = useStore((s) => s.keepCurrent);
  const applyItem = useStore((s) => s.applyItem);
  const openExternal = useStore((s) => s.openExternal);
  const patchItem = useStore((s) => s.patchLibraryItem);
  const openOnSteam = useStore((s) => s.openOnSteam);
  // Settings levels (settingsLevel.ts): the sidebar's rows follow the level like the Settings page's rows do
  const level = useStore((s) => levelOf(s.settings?.settingsLevel));
  const at = (l: Level) => rank(level) >= rank(l);
  const p = lib?.videoPath ?? "";
  const paths = libTargets.map((i) => i.videoPath);
  // a multi-selection: the per-item parts (a scene's own properties, the Workshop community) are each item's own, so none
  const multi = hide.n > 1;
  const sceneProps = !!lib?.isScene && !multi;
  const title = w?.title ?? lib?.title ?? "";
  const web = !!w && w.pageUrl.startsWith("http");

  // NO POP-IN: the body shows once its asynchronous sections are in (a scene's properties — cached per path after the
  // first visit), or after READY_CAP_MS; the duration row is reserved, so it needs no wait
  const [ready, setReady] = useState(() => !sceneProps || scenePropsCache.has(p));
  useEffect(() => { if (ready) return; const t = setTimeout(() => setReady(true), READY_CAP_MS); return () => clearTimeout(t); }, [ready]);

  // ---- the library copy's playback values (volume / speed, drag-preview live, persist on release) ----
  // start from the item's real values — the first paint must not show a 0 volume / 1× speed placeholder
  const [vol, setVol] = useState(() => lib?.volumeOverride ?? globalVolume);
  const [spd, setSpd] = useState(() => lib?.speedOverride ?? globalSpeed);
  const [volOv, setVolOv] = useState(() => lib?.volumeOverride != null);
  const [spdOv, setSpdOv] = useState(() => lib?.speedOverride != null);
  const [wl, setWl] = useState(() => !!lib?.isWhitelisted);
  const [dur, setDur] = useState("");
  // drag tuning: live-preview the desktop throttled (cheap IPC), persist once after the drag settles.
  const prevRef = useRef<{ vol: number | null; spd: number | null; last: number; tm: number | null }>({ vol: null, spd: null, last: 0, tm: null });
  // one pending persist PER FIELD — a shared one let a speed drag replace a volume drag's save
  const persistRef = useRef<Record<"vol" | "spd", { tm: number | null; fn: (() => void) | null }>>({ vol: { tm: null, fn: null }, spd: { tm: null, fn: null } });
  // flush pending persists on unmount (an item switch remounts this) so a quick drag-then-switch still saves the value
  useEffect(() => () => { for (const d of Object.values(persistRef.current)) if (d.tm != null) { clearTimeout(d.tm); d.fn?.(); d.tm = null; d.fn = null; } }, []);
  // the values follow the store's copy (a volume keybind on this item, a patch from another surface, the copy arriving)
  // (adjusted during render on the change, so a keybind's new volume never shows a frame late)
  const [synced, setSynced] = useState({ lib, globalVolume, globalSpeed });
  if (synced.lib !== lib || synced.globalVolume !== globalVolume || synced.globalSpeed !== globalSpeed) {
    setSynced({ lib, globalVolume, globalSpeed });
    setVolOv(lib?.volumeOverride != null); setVol(lib?.volumeOverride ?? globalVolume);
    setSpdOv(lib?.speedOverride != null); setSpd(lib?.speedOverride ?? globalSpeed);
    setWl(!!lib?.isWhitelisted);
  }
  // per item: the video's duration, read at once — no flight to wait for
  const durOf = lib && !lib.isScene ? p : null;
  useEffect(() => {
    if (!durOf) return;
    let alive = true;
    api.duration(durOf).then((r) => alive && setDur(fmtDur(r.seconds))).catch(() => {});
    return () => { alive = false; };
  }, [durOf]);
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
  // a reset to Global drops the field's save still waiting (it would land after the reset and set the old value again)
  const dropPersist = (field: "vol" | "spd") => {
    const d = persistRef.current[field];
    if (d.tm != null) clearTimeout(d.tm);
    d.tm = null; d.fn = null;
  };
  // patch the store too (not just the backend) so the live WallpaperBg + cards reflect it immediately.
  const setVolume = (v: number) => {
    setVol(v); setVolOv(true);
    paths.forEach((t) => patchItem(t, { volumeOverride: v === globalVolume ? null : v }));
    queuePreview({ volume: v });
    queuePersist("vol", () => paths.forEach((t) => api.libraryVolume(t, v)));
  };
  const resetVolume = () => {
    setVolOv(false); setVol(globalVolume); dropPersist("vol");
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
    setSpdOv(false); setSpd(globalSpeed); dropPersist("spd");
    paths.forEach((t) => { patchItem(t, { speedOverride: null }); api.librarySpeed(t, null); });
    queuePreview({ speed: globalSpeed });
  };
  const toggleWl = (b: boolean) => { setWl(b); if (lib) api.libraryWhitelist(p, b); };

  // ---- the library copy's notices ----
  // "Clear" on the crash notice: playable again (POST /library/clear-crash; its library-item-changed tells every other page,
  // a new crash marks it again). The notice and the whitelist row fade out (motion off too — never a pop), then what sat
  // after them glides into their room (a FLIP: measured as the fade starts, played back once they unmount).
  // The notice shows while any item Clear would lift is marked (the open one, or another of the selection), naming how many
  // when it isn't just the open one ("3 selected scenes crashed the player"); the whitelist row is the open item's own.
  // Guard: probe-sidebar lib:clearCrash:*
  const motionOn = useMotion();
  const crashN = !lib ? 0 : new Set([...(lib.hasCrashed ? [p] : []), ...libTargets.filter((t) => t.hasCrashed).map((t) => t.videoPath)]).size;
  const them = crashN > 1 ? "them" : "it";
  const crashText = !crashN ? null : lib?.hasCrashed && crashN === 1 ? "This scene crashed the player — rotations skip it; a click still plays it"
    : `${crashN} selected scene${crashN > 1 ? "s" : ""} crashed the player — rotations skip ${them}; a click still plays ${them}`;
  const crash = useLinger(crashText, CRASH_OUT_MS, motionOn);
  const wlRow = useLinger(lib?.hasCrashed || null, CRASH_OUT_MS, motionOn);
  const crashLeaving = crash.closing || wlRow.closing;
  const bodyRef = useRef<HTMLDivElement>(null);
  const flipFrom = useRef<ReturnType<typeof snapFlip>>(null);
  useLayoutEffect(() => { if (crashLeaving && motionOn) flipFrom.current = snapFlip(bodyRef.current, CRASH_FLIP); }, [crashLeaving, motionOn]);
  useLayoutEffect(() => {
    if (crashLeaving || !flipFrom.current) return;
    glideFlip(flipFrom.current, bodyRef.current, CRASH_FLIP); flipFrom.current = null;
  }, [crashLeaving]);
  // an item that can't play (a preset; any scene while the scene renderer is missing): its notice (the crash notice's
  // block), fading out once it can (its base back, the renderer found), what follows gliding into its room as for the crash notice. Guard: probe-sidebar lib:preset:needsBase*
  const reason = useStore((s) => (lib ? unplayableReasonOf(lib, s.scenesBlocked) : null));
  const presetNote = useLinger(reason, CRASH_OUT_MS, motionOn);
  // one that turns up while the sidebar is open fades in (the body's own entrance plays for one there at the open)
  const [noteAtOpen] = useState(() => reason != null);
  const presetFlip = useRef<ReturnType<typeof snapFlip>>(null);
  useLayoutEffect(() => { if (presetNote.closing && motionOn) presetFlip.current = snapFlip(bodyRef.current, CRASH_FLIP); }, [presetNote.closing, motionOn]);
  const noteShown = useRef(presetNote.value != null);
  useLayoutEffect(() => {
    const shown = presetNote.value != null, was = noteShown.current;
    noteShown.current = shown;
    if (!shown && presetFlip.current) { glideFlip(presetFlip.current, bodyRef.current, CRASH_FLIP); presetFlip.current = null; return; }
    // one arriving pushes what follows down: it glides there (motion off: it takes its place at once)
    if (!shown || was || !motionOn) return;
    const n = bodyRef.current?.querySelector<HTMLElement>("[data-preset-note]");
    if (!n) return;
    const h = n.offsetHeight + parseFloat(getComputedStyle(n).marginTop || "0");
    for (let el = n.nextElementSibling; el; el = el.nextElementSibling) glideY(el, -h);
  }, [presetNote.value, motionOn]);
  // "Uses <base>": the base's own card in the Library, the sidebar on it
  const showBase = (path: string) => {
    if (tab === "browse") { onShowInLibrary(path); return; }
    useStore.getState().focusLib(path); revealCard(`lib-${path}`);
  };
  // On a selection it lifts every selected item's mark, as volume / speed / delete repeat to it. Guard: probe-sidebar lib:clearCrash:multi
  const clearCrash = () => {
    const marked = new Set([...(lib?.hasCrashed ? [p] : []), ...libTargets.filter((t) => t.hasCrashed).map((t) => t.videoPath)]);
    for (const t of marked) {
      patchItem(t, { hasCrashed: false });
      api.libraryClearCrash(t).catch((e) => { patchItem(t, { hasCrashed: true }); useStore.getState().setError(`Couldn't clear the crash mark: ${(e as Error).message}`); });
    }
  };

  // ---- the picture ----
  // Browse's card: the same static the card shows (a /still frame for remote animated items — frame 0 is often black; none for
  // a card made from what Steam said alone: a preset's base, store showBrowseItem), the detail's full-res preview fading in
  // once loaded (or its preview VIDEO, never put in an <img>), the card's own gif. The library's item: its still, its own
  // video file (a scene has none) or a video preview the source shipped, its gif.
  const [detail, setDetail] = useState<{ full: string | null; yt: string | null } | null>(null);
  const detailOf = w?.pageUrl ?? null;
  useEffect(() => {
    if (!w) return;
    let alive = true;
    api.detail(source, w).then((d) => { if (alive) setDetail({ full: d.previewUrl ?? null, yt: d.youtubeUrl ?? null }); }).catch(() => {});
    return () => { alive = false; };
  }, [detailOf, source]); // eslint-disable-line react-hooks/exhaustive-deps
  const local = (f: string | null | undefined) => (f && f.startsWith("/") ? f : null);
  let pic: { base: string; full: string | null; gif: string | null; video: string | null; youtube: string | null;
    files: { video: string | null; gif: string | null; image: string | null } };
  if (w) {
    const previewVid = detail?.full && VIDEO_RE.test(detail.full.split("?")[0]) ? thumb(detail.full, w.pageUrl) : null;
    // "open in your own player" only for a file on this machine (a local Wallpaper Engine folder's item); a Workshop preview
    // is a remote URL, never sent as a path
    pic = { base: w.animatedThumbnailUrl && /^https?:/i.test(w.animatedThumbnailUrl) ? still(w.animatedThumbnailUrl, CARD_STILL_W) : w.thumbnailUrl ? thumb(w.thumbnailUrl) : "",
      full: detail?.full && !previewVid ? thumb(detail.full, w.pageUrl) : null, gif: w.animatedThumbnailUrl ? animUrl(w.animatedThumbnailUrl) : null,
      video: previewVid, youtube: detail?.yt ?? null,
      files: { video: previewVid ? local(detail?.full) : null, gif: local(w.animatedThumbnailUrl), image: local(detail?.full && !previewVid ? detail.full : w.thumbnailUrl) } };
  } else {
    const i = lib!;
    const stillSrc = i.thumbnailPath || i.animatedThumbnailPath, fv = i.filesVersion, an = i.animatedThumbnailPath;
    const gif = an && !VIDEO_RE.test(an) ? animUrl(an, fv) : null;
    // the files behind those layers, for "open in your default app": the backend opens a video or a picture, checked by name
    // and content (.claude/rules/backend/api.md § Security); the Picture is the item's still (else its animated preview)
    pic = { base: stillSrc ? still(stillSrc, CARD_STILL_W, fv) : "",
      full: i.thumbnailPath && !/\.(gif|webp)$/i.test(i.thumbnailPath) ? media(i.thumbnailPath, fv) : stillSrc ? still(stillSrc, undefined, fv) : null,
      gif, video: i.isScene ? null : VIDEO_RE.test(p) ? media(p, fv) : an && VIDEO_RE.test(an) ? media(an, fv) : null, youtube: i.youtubeUrl ?? null,
      files: { video: i.isScene ? null : VIDEO_RE.test(p) ? local(p) : an && VIDEO_RE.test(an) ? local(an) : null, gif: gif ? local(an) : null, image: local(stillSrc) } };
  }
  const online = useOnline();
  const preview = usePreview(tab, { gif: !!pic.gif, video: !!pic.video, youtube: !!pic.youtube && online });
  const play = () => { if (lib) applyItem(lib.videoPath); };

  // ---- the hero row's facts: Browse's card first, then the library's copy ----
  const isScene = (w ?? lib)?.isScene ?? false;
  const isPreset = !!(w ? w.isPreset : lib?.isPreset);
  const resolution = w?.resolution ?? lib?.resolution ?? null;
  // the age rating: the item's own (a local item's project.json), else its age tag (a Workshop item's is a tag)
  const age = w?.ageRating || lib?.ageRating || ageOf(w?.tags ?? lib?.tags) || null;
  const workshopId = w?.workshopId ?? lib?.workshopId ?? null;
  // the Workshop's community (creator, counts, presets, favourite, comments): not for an item the Workshop no longer has, nor a
  // multi-selection (each item has its own)
  const social = workshopId && !lib?.offWorkshop && !multi ? workshopId : null;
  const size = lib?.diskBytes != null || !w ? { bytes: lib?.diskBytes, title: "Size on disk" } : { bytes: w.fileSizeBytes, title: "Size" };
  // the pills above show the resolution and the age rating: their tags would only repeat them
  const tags = sideTags(w?.tags ?? lib?.tags, { resolution: !!resolution, age: !!age });
  const description = w?.description ?? lib?.description ?? null;
  const loud = lib?.isScene ? sceneLoudnessText(lib) : null;
  // a row the level hides still shows when this item has its own value for it — hiding never hides a change
  const showSpeed = at("standard") || libTargets.some((t) => t.speedOverride != null);
  const showLoud = !!loud && at("standard");
  // "Uses Consolas, shown with Cascadia Mono" (each stand-in of the scene's last load, one line)
  const fontLine = lib?.isScene && !multi && lib.fontStandIns?.length
    ? "Uses " + lib.fontStandIns.map((f) => `${f.font}, shown with ${f.shown}`).join("; ") : null;
  // a report that lands while the sidebar is open (the scene just loaded) fades in; one that clears it fades out; what sits
  // below the Playback section glides by the line's height either way (motion off: it takes its place at once)
  const fontNote = useLinger(fontLine, CRASH_OUT_MS, motionOn);
  const fontShown = useRef(fontNote.value != null);
  const fontFlip = useRef<ReturnType<typeof snapFlip>>(null);
  useLayoutEffect(() => { if (fontNote.closing && motionOn) fontFlip.current = snapFlip(bodyRef.current, CRASH_FLIP); }, [fontNote.closing, motionOn]);
  useLayoutEffect(() => {
    const shown = fontNote.value != null, was = fontShown.current;
    fontShown.current = shown;
    if (!shown && fontFlip.current) { glideFlip(fontFlip.current, bodyRef.current, CRASH_FLIP); fontFlip.current = null; return; }
    if (!shown || was || !motionOn) return;
    const line = bodyRef.current?.querySelector<HTMLElement>("[data-scene-fonts]");
    const sec = line?.closest(".side-sec");
    if (!line || !sec) return;
    const h = line.offsetHeight + parseFloat(getComputedStyle(line).marginBottom || "0");
    for (let el = sec.nextElementSibling; el; el = el.nextElementSibling) glideY(el, -h);
  }, [fontNote.value, motionOn]);

  // ---- the action area ----
  // Browse's download of a card the library doesn't hold: its progress + Cancel in place of the buttons
  const progress = useStore((s) => (w ? s.downloads[w.pageUrl] : undefined));
  const downloading = progress !== undefined;
  // a Workshop download's step in words (WS download-progress `status`) — e.g. "Click Subscribe in Steam, then it downloads by
  // itself…" while it waits on the Steam app (WorkshopDownloader)
  const dlStatus = useStore((s) => (w ? s.downloadStatus[w.pageUrl] : undefined));
  const download = useStore((s) => s.download);
  const cancelDownload = useStore((s) => s.cancelDownload);
  // a Workshop item the library doesn't hold: Steam may keep it subscribed (subscribed in Steam without the import, a local
  // Wallpaper Engine folder's item): then its buttons download (import) and an Unsubscribe stands for the subscription
  const subSt = useWsSubState(!lib && w?.workshopId ? w.workshopId : null, !web);
  const subscribedOff = !lib && !!subSt && (subSt.subscribed || subSt.pending === "unsubscribe");
  // Not in the library: a Workshop item's buttons subscribe (every download mode gets it by a subscription, in the modes'
  // order: docs/decisions.md § "Offer two Workshop download modes, the Steam page the last resort"); any other item's download
  const subscribes = !!w && isWorkshopItem(w) && !subscribedOff;
  const GetIcon = subscribes ? CloudDownload : Download;
  const getWord = subscribes ? "Subscribe" : "Download";
  // a download the mode can't do now (components/subscribeMode.ts actionBlocked; none in either mode, every download falls
  // back to the item's Steam page): both buttons disabled up front with the reason as their tooltip, no line under them; their
  // right-click menu still opens (its entries say their own). Guard: probe-steam side:blocked:download, side:getHint
  const getOff = useStore((s) => (w && isWorkshopItem(w) ? actionBlocked(s.settings, s.steam, "download") : null));
  const mode = useStore((s) => s.settings?.workshopDownloadMode);
  const navigate = useStore((s) => s.navigate);
  // A Workshop item's Subscribe buttons have a right-click menu (components/ContextMenu.tsx) with the button's own one-off
  // variant: "Subscribe"'s "Download without subscribing", "Subscribe and apply"'s "… & apply", a copy that stays no
  // subscription (menuItems.tsx oneOffMenuItem; "Download then unsubscribe" where that is how it's done). How it would be
  // fetched (GET /workshop/one-off) is asked as the pointer reaches a button, so the menu opens with its answer: without a
  // way, the entry is disabled and its note says what's missing. Guard: probe-steam side:oneOff:menu, side:oneOff:missing
  // not for an item Steam already keeps subscribed: its Download imports that subscription, and a download-then-unsubscribe
  // route would drop the user's own subscription
  const oneOffable = !!w && isWorkshopItem(w) && !subscribedOff;
  const [getMenu, setGetMenu] = useState<MenuAt | null>(null);
  // the button whose menu is open (kept through the menu's fade out)
  const [menuApply, setMenuApply] = useState(false);
  const [oneOff, setOneOff] = useState<OneOffRoute | null>(null);
  const closeGetMenu = useCallback(() => setGetMenu(null), []);
  const getFrom = useRef<HTMLButtonElement | null>(null);
  const asked = useRef<{ at: number; key: string; p: Promise<OneOffRoute> } | null>(null);
  // the route follows the download mode and the sign-in (a sign-out turns "Subscribe with Steam login"'s off): either changing
  // here asks again at once
  const routeKey = useStore((s) => `${String(s.settings?.workshopDownloadMode)}|${s.steam?.usable ?? (s.steam?.signedIn && !s.steam?.rejected)}`);
  const askOneOff = () => {
    if (asked.current && asked.current.key === routeKey && Date.now() - asked.current.at < ONE_OFF_FRESH_MS) return asked.current.p;
    const q = api.workshopOneOff().catch((): OneOffRoute => ({ route: null, missing: "Couldn't check how to download it here. Try again." }));
    asked.current = { at: Date.now(), key: routeKey, p: q };
    return q;
  };
  const getMenuProps = oneOffable ? {
    "aria-haspopup": "menu" as const,
    onPointerEnter: () => { void askOneOff(); },
    onContextMenu: (e: MouseEvent<HTMLButtonElement>) => {
      e.preventDefault();
      const pt = menuAt(e), apply = e.currentTarget.dataset.sideGet === "apply";
      getFrom.current = e.currentTarget;
      const from = e.currentTarget;
      // an answer that lands after its button went (a download started meanwhile) opens nothing
      void askOneOff().then((r) => { if (!from.isConnected || getFrom.current !== from) return; setOneOff(r); setMenuApply(apply); setGetMenu(pt); });
    },
  } : {};
  const missing = oneOff?.route ? null : oneOff?.missing ?? null;
  const get = (apply: boolean, one = false) => { if (w) void download(source, w, apply, one); };

  // the library copy's removal (components/itemRemoval.ts: the Library's own, on both tabs): the split button's second half
  const rm = useRemoval(clearSel);
  const unsubN = lib ? libTargets.filter(rm.unsubs).length : 0;
  const deleteN = libTargets.length - unsubN;
  const unsubOff = rm.unsubOff;
  // auto-import off: a Workshop item's Delete keeps its subscription; "Delete and unsubscribe" is its right-click entry
  const deleteSource = !!lib?.workshopId && !rm.autoImport;
  const onTrash = () => rm.doTrash(libTargets, onRemoved);
  // the danger half's right-click menu; and when its kind changes under the open sidebar ("Unsubscribe without deleting" made
  // the item a plain local one), the new words cross-fade in (motion on: slide in a little)
  const [dangerMenu, setDangerMenu] = useState<MenuAt | null>(null);
  // what the open menu says, held from its opening: a pick changes the item under it ("Unsubscribe without deleting" leaves no
  // entry), and the menu still fades out with its own words. Guard: probe-steam side:unsub:keepOff
  const closeDangerMenu = useCallback(() => setDangerMenu(null), []);
  const dangerRef = useRef<HTMLButtonElement>(null);
  const dangerKind = unsubN > 0 ? "unsubscribe" : "delete";
  const shownKind = useRef(dangerKind);
  useLayoutEffect(() => {
    if (shownKind.current === dangerKind) return;
    shownKind.current = dangerKind;
    dangerRef.current?.animate(motionOn ? [{ opacity: 0, transform: "translateX(10px)" }, { opacity: 1, transform: "none" }] : [{ opacity: 0 }, { opacity: 1 }],
      { duration: motionOn ? 220 : FADE_MS, easing: motionOn ? "cubic-bezier(.2, .9, .3, 1)" : "linear" });
  }, [dangerKind, motionOn]);
  const [dangerHeld, setDangerHeld] = useState<{ items: MenuItem[]; label: string; note: string | null }>({ items: [], label: "", note: null });
  const openDanger = (e: MouseEvent<HTMLButtonElement>) => {
    setDangerHeld({ items: dangerItems, label: unsubN > 0 ? "Unsubscribe" : "Delete", note: unsubOff });
    setDangerMenu(menuAt(e));
  };
  const dangerItems: MenuItem[] = unsubN > 0 ? [{ ...keepMenuItem(() => rm.doKeep(libTargets)), disabled: !!unsubOff }]
    : deleteSource ? [{ key: "delete-source", label: "Delete and unsubscribe", icon: <CloudOff size={14} />, disabled: !!unsubOff,
      onPick: () => { void rm.doDeleteSource(libTargets, onRemoved); } }] : [];
  // the library's own copy of a Workshop item ("Unsubscribe without deleting", a one-off copy): Subscribe beside the split
  // (POST /workshop/subscribe; with auto-import on Steam's copy then takes the own copy's place,
  // WorkshopSubOps.AfterSubscribeAsync). Not for an item the Workshop no longer has. Guard: probe-steam side:resub
  const ownCopy = !!lib?.workshopId && !lib.offWorkshop && lib.subscribed === false && !multi;
  const subProg = useStore((s) => (ownCopy ? s.subProgress[lib!.workshopId!] : undefined));
  // once subscribed it fades out (the Delete half turns Unsubscribe, sliding in); its words stay put meanwhile
  // useLinger follows a new value during render: one object per state, never a fresh one per render (that loops)
  const ownId = ownCopy ? lib!.workshopId! : null, ownTitle = lib?.title ?? "", ownProg = !!subProg;
  const ownVal = useMemo(() => (ownId ? { id: ownId, title: ownTitle, prog: ownProg } : null), [ownId, ownTitle, ownProg]);
  const ownBtn = useLinger(ownVal, CRASH_OUT_MS, motionOn);
  const subOff = useStore((s) => actionBlocked(s.settings, s.steam, "subscribe"));
  const subscribe = useStore((s) => s.subscribeWorkshop);
  const unsubscribeWs = useStore((s) => s.unsubscribeWorkshop);
  const [busy, setBusy] = useState(false);
  // Unsubscribe for a subscribed item the library doesn't hold: the subscription alone (POST /workshop/unsubscribe). It arrives
  // with the state it waits on (rising in; what follows glides down) and leaves keeping its words (a fade; what follows glides
  // up); motion off: the fades only. Guard: probe-steam steam:sub:workshop, steam:sub:weLocal, steam:subMerge:appear*
  const unsubOnly = async () => {
    if (!w?.workshopId || unsubOff || busy || subSt?.pending) return;
    setBusy(true);
    try { await unsubscribeWs(w.workshopId, w.title); } finally { setBusy(false); }
  };
  const steamPending = !!subSt?.pending;
  const steamVal = useMemo(() => (subscribedOff ? { pending: steamPending } : null), [subscribedOff, steamPending]);
  const steamUnsub = useLinger(steamVal, CRASH_OUT_MS, motionOn);
  const [steamAtOpen] = useState(subscribedOff);
  const steamFlip = useRef<ReturnType<typeof snapFlip>>(null);
  useLayoutEffect(() => { if (steamUnsub.closing && motionOn) steamFlip.current = snapFlip(bodyRef.current, CRASH_FLIP); }, [steamUnsub.closing, motionOn]);
  const steamShown = useRef(!!steamUnsub.value);
  useLayoutEffect(() => {
    const shown = !!steamUnsub.value, was = steamShown.current;
    steamShown.current = shown;
    if (!shown && steamFlip.current) { glideFlip(steamFlip.current, bodyRef.current, CRASH_FLIP); steamFlip.current = null; return; }
    if (!shown || was || !motionOn) return;
    const n = bodyRef.current?.querySelector<HTMLElement>("[data-unsubscribe-steam]");
    const cta = n?.closest(".side-cta");
    if (!n || !cta) return;
    const h = n.offsetHeight + parseFloat(getComputedStyle(cta).rowGap || "0");
    for (let el = cta.nextElementSibling; el; el = el.nextElementSibling) glideY(el, -h);
  }, [steamUnsub.value, motionOn]);

  // ---- the tiles ----
  // Open in file manager: the library's copy, else a local Wallpaper Engine folder's item; the page: Steam's (the Steam CLIENT,
  // POST /steam/open-page; the browser when that couldn't open), else the page it came from
  const reveal = lib ? () => openExternal({ path: lib.videoPath, reveal: true, isScene: lib.isScene, workshopId: lib.workshopId, copiedSceneDir: lib.copiedSceneDir })
    : w && !web ? () => openExternal({ path: w.pageUrl, reveal: true, isScene: w.isScene, workshopId: w.workshopId }) : null;
  const pageUrl = web ? w!.pageUrl : lib?.pageUrl?.startsWith("http") ? lib.pageUrl : null;
  // Steam's favourites count as the favourite's toggle (WorkshopSocial.tsx FavoritePill): a Browse card's count, else asked
  const favPill = social && w ? <FavoritePill workshopId={social} count={w.favorites} /> : undefined;

  return (
    <>
      {/* Browse's card the library holds: "Show in Library" under the close button (the head's tool slot), not a chip */}
      {tab === "browse" && lib && (
        <SideHeadTools>
          <button className="side-tool" data-show-in-library aria-label="Show in Library" title="Show in Library" onClick={() => onShowInLibrary(lib.videoPath)}>
            <LibraryIcon size={16} /></button>
        </SideHeadTools>
      )}
      <SideMedia id={w?.pageUrl ?? p} cardId={w ? `br-${w.pageUrl}` : `lib-${p}`} base={pic.base} full={pic.full} gif={pic.gif} video={pic.video}
        youtube={pic.youtube} preview={preview} wall={lib ? vol : globalVolume} files={pic.files}
        play={lib ? { label: `Play ${title}`, playing, looping: keepCurrent, onPlay: play } : undefined} />
      <div ref={bodyRef} className={`side-body${ready ? "" : " wait"}`}>
        {/* the info pills: facts only, in one order on both tabs (tags live in About). Guard: probe-hidden same:parts */}
        <div className="side-hero">
          {/* its card's type icon, with the type in words (TypeIcon.tsx). Guard: probe-sidebar lib:type:icon */}
          <TypeIcon chip scene={isScene} preset={isPreset} />
          {/* "keep playing this one" is on — the only thing the old "Playing now" pill said that nothing else does */}
          {playing && keepCurrent && <span className="side-chip accent" data-side-looping><Repeat size={12} /> Looping this one</span>}
          {/* reserved before the duration loads: the rows below don't move when it lands */}
          {lib && !lib.isScene && <span className="side-pill" data-side-row="duration" style={{ visibility: dur ? "visible" : "hidden" }}><Clock size={13} /> {dur || "0 seconds"}</span>}
          {resolution && <span className="side-pill" data-side-row="resolution"><Monitor size={13} /> {resolution}</span>}
          {age && <span className="side-pill" data-side-row="age"><Shield size={13} /> {age}</span>}
          {/* Steam's current counts: a Browse card's own, else asked (held unseen while Steam is asked); the favourites pill is
              the favourite's toggle. Guard: probe-steam ws:counts, lib:ws:pillRow, ws:favorite */}
          {!multi && (w ? <StatPills subscriptions={w.subscriptions} favorites={w.favorites} fav={favPill} /> : social && <WorkshopStats workshopId={social} />)}
          {/* the Workshop ID: a pill that copies itself */}
          {workshopId && at("standard") && <WorkshopIdPill id={workshopId} />}
          {/* the name is selectable text (index.css), the way to copy it */}
          {w?.authorName && !w.workshopId && <span className="side-pill" title="Author" data-side-author><User size={13} /> <span className="side-author-name">{w.authorName}</span></span>}
          {/* its files on this disk (measured in the background, Web/LibraryFactsOps.cs), else Steam's download size; last on
              both tabs, so a late measure moves no other pill. Guard: probe-steam lib:ws:size, test-library-facts.sh § 7 */}
          <SizePill bytes={size.bytes} title={size.title} />
        </div>
        {/* the crash mark, as a notice block of the body (the tiles' material, a danger stripe) with its own Clear */}
        {crash.value && (
          <div className={`side-crash${crash.closing ? " leaving" : ""}`} data-side-crash role="status">
            <span className="side-crash-ico"><AlertTriangle size={16} /></span>
            <span className="side-crash-text" data-side-crash-text>{crash.value}</span>
            <button className="mini side-crash-clear" data-side-crash-clear aria-label={crashN > 1 ? "Clear the crash marks" : "Clear the crash mark"} disabled={crash.closing}
              onClick={clearCrash}>Clear</button>
          </div>
        )}
        {lib && presetNote.value && !multi && (
          <PresetNotice item={lib} reason={presetNote.value} closing={presetNote.closing} arrive={!noteAtOpen} />
        )}
        {/* Steam's cooldown: why the creator, the favourite and the comments wait (they ask again at its end) */}
        <SideCooldownNotice on={!!social} body={bodyRef} />
        {/* the action area, one on both tabs. The library's copy: one split button, Play | Unsubscribe (a Workshop item Steam
            keeps subscribed, with auto-import on: components/itemRemoval.ts; its right-click "Unsubscribe without deleting") or
            Play | Delete (its right-click, a Workshop item with auto-import off: "Delete and unsubscribe"); a mixed selection
            says what happens to each part. Play applies it (the picture's click too). Not in the library: Subscribe and apply /
            Subscribe (Download for an item that isn't a Workshop result, or that Steam already keeps subscribed: then an
            Unsubscribe too). No line under the buttons: a reason is the disabled control's tooltip or its menu's note.
            Guard: probe-hidden same:actions, same:play; probe-steam side:unsub:*, side:deleteSource:names */}
        <div className="side-cta" data-side-part="cta">
          {downloading ? (
            <div className="side-dl" data-side-download>
              <span className="shint" data-side-download-status>{progress! > 0 ? `Downloading ${Math.round(progress! * 100)}%` : dlStatus || "Downloading…"}</span>
              <div className="dl-bar"><div className="dl-fill" style={{ width: `${Math.round((progress || 0) * 100)}%` }} /></div>
              <button className="btn ghost ico" onClick={() => cancelDownload(w!.pageUrl)}><X size={14} /> Cancel</button>
            </div>
          ) : lib ? (
            <>
              <div className="side-split" data-side-split>
                <button className="btn accent ico side-go" data-side-apply ref={magnetRef} onClick={play}><Play size={15} fill="currentColor" /> Play</button>
                {unsubN > 0 ? (
                  <button ref={dangerRef} className="btn danger ico side-go" data-unsubscribe aria-haspopup="menu" aria-disabled={unsubOff ? true : undefined}
                    onClick={unsubOff ? undefined : onTrash} onContextMenu={(e) => { e.preventDefault(); openDanger(e); }}
                    title={unsubOff ?? `Also removes ${unsubN > 1 ? "them" : "it"} from your library; right-click keeps ${unsubN > 1 ? "them" : "it"}. Undo subscribes again`}>
                    <CloudOff size={15} />
                    {deleteN ? (unsubOff ? `Unsubscribe ${unsubN}` : `Unsubscribe ${unsubN}, delete ${deleteN}`) : "Unsubscribe"}</button>
                ) : (
                  <button ref={dangerRef} className="btn danger ico side-go" data-delete aria-haspopup={deleteSource ? "menu" : undefined} onClick={onTrash}
                    onContextMenu={deleteSource ? (e) => { e.preventDefault(); openDanger(e); } : undefined}
                    title={deleteSource ? "Right-click unsubscribes on Steam too" : undefined}>
                    <Trash2 size={15} />Delete</button>
                )}
              </div>
              {unsubN > 0 && deleteN > 0 && unsubOff && (
                <button className="btn danger ico side-go" data-delete-rest onClick={onTrash}><Trash2 size={15} />{`Delete ${deleteN}`}</button>
              )}
              {ownBtn.value && (
                <button className={`btn ghost ico side-go${ownBtn.closing ? " leaving" : ""}`} data-side-subscribe
                  aria-disabled={subOff || ownBtn.value.prog || ownBtn.closing ? true : undefined} title={subOff ?? "Steam keeps it up to date"}
                  onClick={subOff || ownBtn.value.prog || ownBtn.closing ? undefined : () => void subscribe(ownBtn.value!.id, ownBtn.value!.title)}>
                  {ownBtn.value.prog ? <LoaderCircle size={15} className="side-sub-spin" /> : <CloudDownload size={15} />}
                  {ownBtn.value.prog ? "Subscribing…" : "Subscribe"}</button>
              )}
            </>
          ) : w && (
            <>
              <button className="btn accent ico side-go" data-side-get="apply" ref={magnetRef} aria-disabled={getOff ? true : undefined} title={getOff ?? undefined}
                onClick={getOff ? undefined : () => get(true)} {...getMenuProps}><span className="side-dl-ico"><GetIcon size={16} /></span> {getWord} and apply</button>
              <button className="btn ghost ico side-go" data-side-get="only" aria-disabled={getOff ? true : undefined} title={getOff ?? undefined}
                onClick={getOff ? undefined : () => get(false)} {...getMenuProps}><span className="side-dl-ico"><GetIcon size={15} /></span> {getWord}</button>
              {steamUnsub.value && (
                <button className={`btn danger ico side-go side-cta-row${steamUnsub.closing ? " leaving" : ""}${steamAtOpen ? "" : " arrive"}`} data-unsubscribe-steam
                  aria-disabled={unsubOff || busy || steamUnsub.value.pending || steamUnsub.closing ? true : undefined}
                  title={unsubOff ?? "Steam removes its files"} onClick={unsubOnly}>
                  {steamUnsub.value.pending ? <LoaderCircle size={15} className="side-sub-spin" /> : <CloudOff size={15} />}
                  {steamUnsub.value.pending ? "Unsubscribing…" : "Unsubscribe"}</button>
              )}
            </>
          )}
        </div>
        {/* outside the buttons' branch: a pick starts the download, and the menu still fades out once they're gone */}
        {oneOffable && <ContextMenu at={getMenu} onClose={closeGetMenu} returnTo={getFrom} label="Download" note={missing}
          items={[oneOffMenuItem(menuApply, mode, () => get(menuApply, true), missing)]} />}
        <ContextMenu at={dangerMenu} onClose={closeDangerMenu} returnTo={dangerRef} label={dangerHeld.label} items={dangerHeld.items} note={dangerHeld.note} />
        {/* the two Workshop download modes, said once under a Workshop item's Subscribe buttons with the way to the other one: a
            one-time tip, dismissed for good (components/Tip.tsx), not a hint line. Guard: --probe probe-firstrun.js tip:downloadModes */}
        <Tip id="downloadModes" when={!!w && !lib && isWorkshopItem(w)} action={{ label: "Settings", onClick: () => navigate("settings", "workshop") }}>
          {mode === "subscribe" ? "Downloads use your Steam login. Settings can switch them to the Steam app."
            : "Downloads use the Steam app. Settings can switch them to your Steam login."}</Tip>
        {/* who made it (a click lists all their wallpapers in Browse). Guard: probe-steam lib:ws:creator, ws:creator */}
        {social && <CreatorRow workshopId={social} authorId={w?.authorId ?? null} onListed={tab === "library" ? onShowInBrowse : undefined} />}
        {/* a scene: the presets made for it, listed in Browse (only while presets can play); a preset: the scene it plays (the
            library copy's from its own file, Steam isn't asked). Guard: probe-sidebar lib:presets:scene, lib:preset:uses */}
        {social && isScene && !isPreset && <PresetsRow workshopId={social} title={title} scene={w ?? undefined} onListed={tab === "library" ? onShowInBrowse : undefined} />}
        {isPreset && !multi && (lib?.baseWorkshopId || w?.workshopId) && (
          <BaseRow presetId={workshopId ?? p} local={lib?.baseWorkshopId ? { baseId: lib.baseWorkshopId, title: lib.baseTitle ?? null, path: lib.basePath ?? null } : undefined}
            onShowInLibrary={showBase} onShowInBrowse={tab === "library" ? onShowInBrowse : undefined} />
        )}
        {(description || tags.length > 0) && (
          <SideSection icon={<Info size={15} />} title="About" data-sec="about">
            {description && <p className="desc">{description}</p>}
            {tags.length > 0 && <div className="tags side-tags">{tags.map((t) => <span key={t} className="tag">{t}</span>)}</div>}
          </SideSection>
        )}
        {/* the tiles, one row on both tabs. Hide / Unhide act on the selection that holds this card (the top bar's Undo brings a
            hidden one back; the filters' Hidden row shows them, with Unhide): docs/decisions.md § "One sidebar for an item, the same on both tabs". Guard: probe-hidden hide:* */}
        <div className="side-tiles" data-side-part="tiles">
          {reveal && <button className="side-tile" data-reveal onClick={reveal}><span className="side-tile-ico"><FolderFlap size={15} /></span>Open in file manager</button>}
          {workshopId ? (
            <button className="side-tile" data-open-steam onClick={() => openOnSteam(workshopId)}><span className="side-tile-ico"><ExternalLink size={15} /></span>Open on Steam</button>
          ) : pageUrl && (
            <button className="side-tile" data-open-page onClick={() => openExternal({ url: pageUrl })}><span className="side-tile-ico"><ExternalLink size={15} /></span>Open page</button>
          )}
          <button className="side-tile" data-side-hide={hide.hidden ? "unhide" : "hide"} onClick={hide.hidden ? hide.onUnhide : hide.onHide}>
            <span className="side-tile-ico">{hide.hidden ? <Eye size={15} /> : <EyeOff size={15} />}</span>
            {`${hide.hidden ? "Unhide" : "Hide"}${hide.n > 1 ? ` ${hide.n}` : ""}`}</button>
        </div>
        {lib && (
          <SideSection icon={<SlidersHorizontal size={15} />} title="Playback" data-sec="playback">
            {wlRow.value && (
              <label className={`inline side-wl${wlRow.closing ? " leaving" : ""}`}>
                <input type="checkbox" checked={wl} onChange={(e) => toggleWl(e.target.checked)} /> Keep in playlist despite crash (whitelist)
              </label>
            )}
            <div className="srow" data-side-row="volume"><div className="slabel"><span className="slabel-row">Volume{!volOv && <span className="side-global">global</span>}</span><span className="side-val">{vol}</span></div>
              <div className="sctl"><input type="range" aria-label="Volume" min={0} max={100} value={vol} style={rangeFill(vol, 0, 100)} onChange={(e) => setVolume(+e.target.value)} />
                {volOv && <button className="mini ico" onClick={resetVolume}><RotateCcw size={13} /> Global</button>}</div></div>
            {showSpeed && (
              <div className="srow" data-side-row="speed"><div className="slabel"><span className="slabel-row">Speed{!spdOv && <span className="side-global">global</span>}</span><span className="side-val">{spd}×</span></div>
                <div className="sctl"><input type="range" aria-label="Speed" min={0.1} max={4} step={0.1} value={spd} style={rangeFill(spd, 0.1, 4)} onChange={(e) => setSpeed(+e.target.value)} />
                  {spdOv && <button className="mini ico" onClick={resetSpeed}><RotateCcw size={13} /> Global</button>}</div></div>
            )}
            {showLoud && (
              <div className="side-line" data-scene-loudness-line data-side-row="loudness" title="the scene's loudness under its current properties — normalization matches it to the target">
                <AudioLines size={14} /> {loud}</div>
            )}
            {showLoud && lib.loudnessEstimated && lib.loudnessNote && (
              <div className="shint side-note" data-scene-loudness-note>Estimate may be off: {lib.loudnessNote}</div>
            )}
            {/* a font the scene asks for that this machine doesn't have, and the family fontconfig drew it with (the player's
                scene.fonts at its last load; docs/decisions.md § "Scene fonts come from fontconfig, not a Windows install"):
                one muted line, no setting. Guard: probe-sidebar lib:fontStandIn */}
            {fontNote.value && <div className={`shint side-note side-fonts${fontNote.closing ? " leaving" : ""}`} data-scene-fonts>{fontNote.value}</div>}
          </SideSection>
        )}
        {/* what this sidebar's settings are, said once under them: the wallpaper's own, the global ones elsewhere. Guard: --probe
            probe-firstrun.js tip:itemSettings */}
        {lib && <Tip id="itemSettings">{multi ? "These change each selected wallpaper's own. Settings has the ones for all of them."
          : "These are this wallpaper's own. Settings has the ones for all of them."}</Tip>}
        {/* a WE scene's own options (per item — not for a multi-selection: each scene has its own set) */}
        {lib && sceneProps && <ScenePropsEditor key={p} path={p} preset={!!lib.isPreset} onReady={() => setReady(true)} />}
        {/* a Workshop item's comments, last: read once they scroll into view (the sidebar's open asks Steam for nothing more).
            Guard: probe-steam lib:ws:*, ws:comments */}
        {social && <CommentsSection workshopId={social} authorId={w?.authorId ?? null} />}
      </div>
    </>
  );
}

// API: Helpers/Presets.cs NeedsBaseReason, word for word: the one reason a download of the base answers
const NEEDS_BASE = "Needs its base scene";

// A preset that can't play, as a notice of the body (the crash notice's block and words' style). "Needs its base scene" gets
// "Download it again": the base through the current download mode (store download, its Workshop id), as a one-off only when
// the preset is the library's own copy (a one-off itself) and the mode has a one-off route (GET /workshop/one-off), else as
// a plain download; a mode that can't do it now shows the button disabled with the reason under the words, never another
// mode's route. While it downloads the button says so; once the base lands the library's re-read takes the notice away.
// Guard: probe-sidebar lib:preset:needsBase, lib:preset:needsBaseOff
function PresetNotice({ item, reason, closing, arrive }: { item: LibraryItem; reason: string; closing: boolean; arrive: boolean }) {
  if (reason === DOWNLOAD_INCOMPLETE) return <IncompleteNotice item={item} closing={closing} arrive={arrive} />;
  return <BaseNotice item={item} reason={reason} closing={closing} arrive={arrive} />;
}

// A Workshop download Steam left empty (GET /library downloadIncomplete), in the same notice block, with "Redownload": the
// store's redownload (POST /library/redownload, the download mode's order). A mode that can't download now shows it disabled
// with the reason under the words (components/subscribeMode.ts actionBlocked), never another mode's route; while it runs the
// button says so and the line under the words carries Steam's step; once whole, the backend's library-item-changed takes the
// notice away. Guard: probe-sidebar lib:incomplete
function IncompleteNotice({ item, closing, arrive }: { item: LibraryItem; closing: boolean; arrive: boolean }) {
  const page = item.workshopId ? steamPageUrl(item.workshopId) : "";
  const progress = useStore((s) => (page ? s.downloads[page] : undefined));
  const step = useStore((s) => (page ? s.downloadStatus[page] : undefined));
  const blocked = useStore((s) => (item.workshopId ? actionBlocked(s.settings, s.steam, redownloadAction(item)) : null));
  const redownload = useStore((s) => s.redownload);
  const busy = progress !== undefined;
  const why = busy ? step ?? null : blocked;
  return (
    <div className={`side-crash side-preset${closing ? " leaving" : ""}${arrive ? " arrive" : ""}`} data-preset-note={DOWNLOAD_INCOMPLETE} role="status">
      <span className="side-crash-ico"><FileWarning size={16} /></span>
      <span className="side-crash-text">{DOWNLOAD_INCOMPLETE}
        <span className="side-preset-why" data-preset-why>{why ?? "Steam left its files empty, so it can't play"}</span></span>
      {item.workshopId && (
        <button className="mini ico side-crash-clear" data-redownload disabled={closing}
          aria-disabled={blocked || busy ? true : undefined} onClick={() => { if (!blocked && !busy) void redownload(item); }}>
          <Download size={13} />{busy ? (progress > 0 ? `Downloading ${Math.round(progress * 100)}%` : "Downloading…") : "Redownload"}</button>
      )}
    </div>
  );
}

function BaseNotice({ item, reason, closing, arrive }: { item: LibraryItem; reason: string; closing: boolean; arrive: boolean }) {
  const baseId = reason === NEEDS_BASE ? item.baseWorkshopId ?? null : null;
  const ownCopy = item.subscribed === false;
  const [route, setRoute] = useState<OneOffRoute | null>(null);
  useEffect(() => {
    if (!baseId || !ownCopy) return;
    let alive = true;
    api.workshopOneOff().then((r) => { if (alive) setRoute(r); }).catch(() => { if (alive) setRoute({ route: null, missing: null }); });
    return () => { alive = false; };
  }, [baseId, ownCopy]);
  const oneOff = ownCopy && !!route?.route;
  const ws = useStore((s) => s.sources.find((x) => x.supportsTagFilter && x.available)?.index ?? null);
  const blocked = useStore((s) => (baseId ? actionBlocked(s.settings, s.steam, oneOff ? "oneOff" : "download") : null));
  const pageUrl = baseId ? steamPageUrl(baseId) : "";
  const progress = useStore((s) => (pageUrl ? s.downloads[pageUrl] : undefined));
  const download = useStore((s) => s.download);
  // a one-off asked but not answered yet: wait for it (the route decides which download it is)
  const asking = !!baseId && ownCopy && !route;
  const why = !baseId ? null : ws == null ? "The Workshop isn't available right now" : blocked;
  const busy = progress !== undefined;
  const get = () => {
    if (!baseId || ws == null || why || asking || busy) return;
    void download(ws, workshopStub(baseId, item.baseTitle ?? "Its base scene", true), false, oneOff);
  };
  const text = baseId && item.baseTitle ? `Needs its base scene, ${item.baseTitle}` : reason;
  return (
    <div className={`side-crash side-preset${closing ? " leaving" : ""}${arrive ? " arrive" : ""}`} data-preset-note={reason} role="status">
      <span className="side-crash-ico"><Unplug size={16} /></span>
      <span className="side-crash-text">{text}{why && <span className="side-preset-why" data-preset-why>{why}</span>}</span>
      {baseId && (
        <button className="mini ico side-crash-clear" data-preset-get={oneOff ? "one-off" : "download"} disabled={closing}
          aria-disabled={why || asking || busy ? true : undefined} onClick={get}>
          <Download size={13} />{busy ? (progress > 0 ? `Downloading ${Math.round(progress * 100)}%` : "Downloading…") : "Download it again"}</button>
      )}
    </div>
  );
}
