import { useCallback, useEffect, useRef, useState, lazy, Suspense } from "react";
import { LayoutGroup } from "framer-motion";
import { RefreshCw, Square, Undo2, Upload } from "lucide-react";
import { useStore } from "./store";
import { useEvents, type LpEvent } from "./api/events";
import { Browse } from "./views/Browse";
import { Library } from "./views/Library";
import { PlaylistStrip } from "./components/PlaylistStrip";
import { PreviewModal } from "./components/PreviewModal";
import { LibrarySettingsModal } from "./components/LibrarySettingsModal";
import type { Wallpaper } from "./api/client";
import { CLIENT_ID } from "./api/client";
import { startFreezeLog } from "./debug/freezeLog";
import { WallpaperBg } from "./components/WallpaperBg";
import { Select } from "./components/Select";
// PERF: code-split the bits not on the first paint (Settings is the 3rd tab; Steam/Error/Drain are
// rarely-shown overlays; DebugHud only matters under LIVEPAPER_DEBUG_IPC). Keeps the initial parse
// small + lets Electron's V8 code cache hit the stable vendor chunk across launches. The morph modals
// (Preview/LibrarySettings) stay eager — a lazy Suspense gap would break the first card→modal morph.
const Settings = lazy(() => import("./views/Settings").then((m) => ({ default: m.Settings })));
const SteamModal = lazy(() => import("./components/SteamModal").then((m) => ({ default: m.SteamModal })));
const DrainToast = lazy(() => import("./components/DrainToast").then((m) => ({ default: m.DrainToast })));
const ErrorModal = lazy(() => import("./components/ErrorModal").then((m) => ({ default: m.ErrorModal })));
const DebugHud = lazy(() => import("./debug/DebugHud").then((m) => ({ default: m.DebugHud })));

type Tab = "browse" | "library" | "settings";
const SORTS = ["Name A–Z", "Name Z–A", "Videos first", "Scenes first", "Newest", "Oldest"];
const BROWSE_SORTS = ["Default", "Name A–Z", "Name Z–A", "Videos first", "Scenes first", "Newest", "Oldest"];

export default function App() {
  const s = useStore();
  const [tab, setTab] = useState<Tab>("library");
  const [preview, setPreview] = useState<Wallpaper | null>(null);
  const importRef = useRef<HTMLInputElement>(null);

  useEffect(() => { s.init().catch(console.error); }, []); // eslint-disable-line
  useEffect(() => { startFreezeLog(); }, []); // diagnostic heartbeat → ~/.cache/livepaper/freeze.log (catches the wedge)

  // backend push events → targeted store updates
  const onEvent = useCallback((e: LpEvent) => {
    if (e.type === "download-progress") s.setDownload(e.payload.id, e.payload.value);
    else if (e.type === "wallpaper-changed") s.setPlaying(e.payload.path);
    else if (e.type === "settings-changed") s.mergeSettings(e.payload);
    else if (e.type === "steam-qr") s.setQrPng(e.payload.png);
    else if (e.type === "steam-signed-in") s.onSignedIn(e.payload);
    else if (e.type === "steam-qr-error") s.setStatus("Steam: " + e.payload.message);
    else if (e.type === "unsub-progress")
      s.setUnsub(e.payload.finished ? null : { done: e.payload.done, total: e.payload.total, currentId: e.payload.currentId, active: true });
    else if (e.type === "library-synced") s.loadLibrary();
    else if (e.type === "library-item-changed") s.itemChangedByBackend(e.payload.path, { volumeOverride: e.payload.volumeOverride });
    // lp-player's VRAM guard stopped a scene (not a crash — it stays playable): say why
    else if (e.type === "scene-vram-stopped") {
      const t = useStore.getState().libraryItems.find((i) => i.videoPath === e.payload.path)?.title ?? e.payload.path.split("/").pop();
      s.setStatus(`${t}: ${e.payload.message}`, true, true); // held: the rotation's switch off it lands right after
    }
    // a scene broke for good (lp-player: past its restart budget) — the backend marked it crashed in its index:
    // its card shows it at once (it used to wait for the next library reload)
    else if (e.type === "scene-crashed") s.itemChangedByBackend(e.payload.path, { hasCrashed: true });
    // another client (a script, a second window) saved the playlist: a stale strip would save itself back over it
    else if (e.type === "playlist-changed" && e.payload.client !== CLIENT_ID) s.syncPlaylist();
  }, []); // eslint-disable-line
  // the backend came back (a restart under the open page): re-read everything it mirrors; a Browse list the outage
  // left empty loads again
  const onReconnect = useCallback(() => {
    s.resync().catch(() => {});
    const st = useStore.getState();
    if (!st.wallpapers.length && !st.loading && st.sources.length) s.reload().catch(() => {});
  }, []); // eslint-disable-line
  useEvents(onEvent, onReconnect);

  // (Escape closes the preview from inside it — morphing back into its card, components/useMorph.ts)

  // FREEZE FIX: pause all gif animation when the window is hidden OR loses focus (you fullscreen
  // another app over it). On X11 an occluded window keeps reporting visible, so without this the
  // autoplay gifs decode forever in the background → ThreadPool backlog → eventual main-thread wedge.
  // focus/blur fire even when the window is merely occluded (another app took focus), unlike
  // visibilitychange. See store.appActive — gif `active` gates AND this.
  useEffect(() => {
    const sync = () => useStore.setState({ appActive: document.visibilityState === "visible" && document.hasFocus() });
    sync();
    for (const ev of ["visibilitychange", "focus", "blur"] as const) addEventListener(ev, sync, true);
    // authoritative WM signal from the Electron main process (preload window.lp.onActiveChange) — fires
    // on real focus changes even when X11 occlusion keeps the DOM reporting "visible".
    (window as unknown as { lp?: { onActiveChange?: (cb: (v: boolean) => void) => void } }).lp?.onActiveChange?.(
      (v) => useStore.setState({ appActive: v }));
    return () => { for (const ev of ["visibilitychange", "focus", "blur"] as const) removeEventListener(ev, sync, true); };
  }, []);

  // PERF: while a modal is open, freeze the (invisible, behind the opaque backdrop) card gif overlays
  // via CSS — pure-waste animation that janks the morph. Class toggle = no 300-card re-render.
  // Keep frozen through the close-morph too (~380ms) or the gifs resume mid-morph-back → jank.
  useEffect(() => {
    if (s.settingsItem || preview) { document.body.classList.add("modal-open"); return; }
    const t = setTimeout(() => document.body.classList.remove("modal-open"), 380);
    return () => clearTimeout(t);
  }, [s.settingsItem, preview]);

  // ThumbnailAspect drives thumb aspect-ratio. Column count is per-container (useGridFit:
  // derived from window size + CardSize target count + aspect → constant visible count on resize).
  useEffect(() => {
    const aspect = ({ "1:1": "1 / 1", "16:9": "16 / 9", Default: "16 / 9" } as Record<string, string>)[(s.settings?.thumbnailAspect as string)] ?? "16 / 9";
    document.documentElement.style.setProperty("--thumb-aspect", aspect);
  }, [s.settings?.thumbnailAspect]);

  // Chrome (bars/modals/dropdowns) goes translucent ONLY when the live wallpaper is behind every tab;
  // otherwise it's fully opaque. Drives the :root.bg-live translucency vars (--tr / --tr-strong).
  useEffect(() => {
    document.documentElement.classList.toggle("bg-live", !!s.settings?.wallpaperBgAllTabs);
  }, [s.settings?.wallpaperBgAllTabs]);

  // Library-tab Import (parity: library action lives here, not buried in Settings).
  const onImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] as (File & { path?: string }) | undefined;
    if (f?.path) s.importFile(f.path, f.name.replace(/\.[^.]+$/, ""));
    e.target.value = "";
  };

  const src = s.sources[s.activeSource];
  const gVol = (s.settings?.volume as number) ?? 100;
  const gSpd = (s.settings?.speed as number) ?? 1;
  const bgAllTabs = !!(s.settings?.wallpaperBgAllTabs);
  return (
    <div className="app">
      {/* live wallpaper behind the UI — Settings always, or every tab when the advanced toggle is on */}
      {(tab === "settings" || bgAllTabs) && <WallpaperBg />}
      <div className="topbar">
        <div className="tabs">
          {(["browse", "library", "settings"] as Tab[]).map((t) => (
            <button key={t} className={`tab${tab === t ? " active" : ""}`} onClick={() => setTab(t)}>
              {t[0].toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>

        {tab === "browse" && (
          <div className="pills">
            {s.sources.filter((x) => x.available).map((x) => (
              <button key={x.index} className={`pill${s.activeSource === x.index ? " active" : ""}`}
                onClick={() => s.setSource(x.index)}>{x.name}</button>
            ))}
            <button className="mini" title="Refresh" onClick={() => s.reload()}><RefreshCw size={16} /></button>
          </div>
        )}

        <div className="spacer" />

        {/* status in the topbar: "Your downloaded wallpapers" (library) replaced by the active status + Undo */}
        {s.status
          ? <span className="status">{s.status}</span>
          : tab === "library" && <span className="status muted-status">Your downloaded wallpapers</span>}
        {s.undoDepth > 0 && <button className="btn ghost ico glow-pulse" onClick={() => s.undo()}><Undo2 size={14} /> Undo</button>}

        {/* Stop — red/danger with a soft glow */}
        {s.playingPath && <button className="btn danger ico glow-stop" title="Stop playback" onClick={() => s.stop()}><Square size={14} fill="currentColor" /> Stop</button>}

        {tab === "browse" && src?.supportsSearch && (
          <input className="search" placeholder={`Search ${src.name}…`} value={s.query}
            onChange={(e) => s.setQuery(e.target.value)} />
        )}
        {tab === "browse" && src?.supportsSorting && (
          <Select value={s.browseSort} onChange={(v) => s.setBrowseSort(+v)}
            options={BROWSE_SORTS.map((l, i) => ({ value: String(i), label: l }))} />
        )}
        {tab === "library" && (
          <>
            <button className="btn ghost ico" title="Import a local wallpaper" onClick={() => importRef.current?.click()}><Upload size={14} /> Import</button>
            <input ref={importRef} type="file" accept=".mp4,.webm,.mov,.mkv,.avi,.gif,.png,.jpg,.jpeg,.webp"
              style={{ display: "none" }} onChange={onImportFile} />
            <input className="search" placeholder="Search library…" value={s.libQuery}
              onChange={(e) => s.setLibQuery(e.target.value)} />
            <Select value={s.libSort} onChange={(v) => s.setLibSort(+v)}
              options={SORTS.map((l, i) => ({ value: String(i), label: l }))} />
          </>
        )}
      </div>

      {s.loading && <div className="loadbar" />}

      {/* one LayoutGroup spanning the cards AND the modal → card↔preview morph works both ways */}
      <LayoutGroup>
        {tab === "browse" && <Browse onPreview={setPreview} previewUrl={preview?.pageUrl ?? null} />}
        {tab === "library" && <Library />}
        {tab === "settings" && <Suspense fallback={<div className="loadbar" />}><Settings /></Suspense>}

        {tab === "library" && <PlaylistStrip />}

        <PreviewModal w={preview} source={s.activeSource} onClose={() => setPreview(null)}
          onDownload={(w) => s.download(s.activeSource, w, true)} />
        {/* lifted: library cards AND strip items open it; it morphs out of / back into them (components/morph.ts) */}
        <LibrarySettingsModal item={s.settingsItem} siblings={s.settingsSiblings} morphId={s.settingsMorphId} source={s.settingsSource}
          globalVolume={gVol} globalSpeed={gSpd} onClose={s.closeItemSettings} />
      </LayoutGroup>
      <Suspense fallback={null}>
        <SteamModal />
        <DrainToast />
        <ErrorModal />
        <DebugHud setTab={(t) => setTab(t as Tab)} getScroll={() => document.querySelector<HTMLElement>(".scroll")} />
      </Suspense>
    </div>
  );
}
