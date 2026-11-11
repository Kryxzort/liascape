import { useCallback, useEffect, useRef, useState, lazy, Suspense } from "react";
import { LEVELS, LEVEL_HINT, LEVEL_LABEL, levelOf } from "./settingsLevel";
import { LayoutGroup } from "framer-motion";
import { LocateFixed, RefreshCw, Square, Undo2, Upload } from "lucide-react";
import { glideTo } from "./hooks/travelToPlaying";
import { useStore } from "./store";
import { useEvents, type LiascapeEvent } from "./api/events";
import { Browse } from "./views/Browse";
import { Library } from "./views/Library";
import { PlaylistBar } from "./components/PlaylistBar";
import { useMotion } from "./components/motion";
import { CLIENT_ID } from "./api/client";
import { startFreezeLog } from "./debug/freezeLog";
import { WallpaperBg } from "./components/WallpaperBg";
import { Select } from "./components/Select";
// PERF: code-split the bits not on the first paint (Settings is the 3rd tab; Steam/Error/Drain are
// rarely-shown overlays; DebugHud only matters under LIASCAPE_DEBUG_IPC). Keeps the initial parse
// small + lets Electron's V8 code cache hit the stable vendor chunk across launches. The item sidebars stay eager (their
// views import them).
const Settings = lazy(() => import("./views/Settings").then((m) => ({ default: m.Settings })));
const SteamModal = lazy(() => import("./components/SteamModal").then((m) => ({ default: m.SteamModal })));
const DrainToast = lazy(() => import("./components/DrainToast").then((m) => ({ default: m.DrainToast })));
const ErrorModal = lazy(() => import("./components/ErrorModal").then((m) => ({ default: m.ErrorModal })));
const DebugHud = lazy(() => import("./debug/DebugHud").then((m) => ({ default: m.DebugHud })));

type Tab = "browse" | "library" | "settings";
const TAB_ORDER: Tab[] = ["browse", "library", "settings"];
const SORTS = ["Name A–Z", "Name Z–A", "Videos first", "Scenes first", "Newest", "Oldest"];
const BROWSE_SORTS = ["Default", "Name A–Z", "Name Z–A", "Videos first", "Scenes first", "Newest", "Oldest"];

export default function App() {
  const s = useStore();
  const motion = useMotion(); // "Smooth window animations" && !prefers-reduced-motion
  const [tab, setTabNow] = useState<Tab>("library");
  // COOL: the tab switch slides — the active pill glides under the tabs, the new page slides in from the side it's on
  // (index.css `.tab-pill`, `.app[data-tab-dir]`; transform + opacity only; :root.no-motion → none). No direction until
  // the first switch, so the app's first page doesn't slide in.
  const [tabDir, setTabDir] = useState<"l" | "r" | null>(null);
  const setTab = (t: Tab) => { if (t !== tab) setTabDir(TAB_ORDER.indexOf(t) > TAB_ORDER.indexOf(tab) ? "r" : "l"); setTabNow(t); };
  const importRef = useRef<HTMLInputElement>(null);
  // the item sidebar starts under the top bar, whose height changes as it wraps (any window size): --topbar-h on .app
  const appRef = useRef<HTMLDivElement>(null);
  const topbarRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const tb = topbarRef.current, a = appRef.current;
    if (!tb || !a) return;
    const ro = new ResizeObserver(() => a.style.setProperty("--topbar-h", `${tb.getBoundingClientRect().bottom - a.getBoundingClientRect().top}px`));
    ro.observe(tb);
    return () => ro.disconnect();
  }, []);

  useEffect(() => { s.init().catch(console.error); }, []); // eslint-disable-line
  useEffect(() => { startFreezeLog(); }, []); // diagnostic heartbeat → ~/.cache/liascape/freeze.log (catches the wedge)

  // backend push events → targeted store updates
  const onEvent = useCallback((e: LiascapeEvent) => {
    if (e.type === "download-progress") s.setDownload(e.payload.id, e.payload.value);
    else if (e.type === "wallpaper-changed") s.setPlaying(e.payload.path);
    else if (e.type === "settings-changed") s.mergeSettings(e.payload);
    else if (e.type === "loop-current") { s.setKeepCurrent(e.payload.keep); s.setStatus(e.payload.message); }
    else if (e.type === "steam-qr") s.setQrPng(e.payload.png);
    else if (e.type === "steam-signed-in") s.onSignedIn(e.payload);
    else if (e.type === "steam-qr-error") s.setStatus("Steam: " + e.payload.message);
    else if (e.type === "unsub-progress")
      s.setUnsub(e.payload.finished ? null : { done: e.payload.done, total: e.payload.total, currentId: e.payload.currentId, active: true });
    else if (e.type === "library-synced") s.loadLibrary();
    else if (e.type === "library-item-changed") { const { path, ...changed } = e.payload; s.itemChangedByBackend(path, changed); }
    // the scene-loudness queue: "Estimating scene loudness 12 / 96…" in the topbar while it runs, a timed line at its end
    else if (e.type === "scene-loudness-progress") {
      const p = e.payload;
      if (p.finished) {
        s.setSceneLoudness(null);
        s.setStatus(p.cancelled ? "Scene loudness: cancelled" : `Scene loudness: estimated ${p.done} scene${p.done === 1 ? "" : "s"}`);
      } else {
        s.setSceneLoudness({ done: p.done, total: p.total, currentId: p.currentId });
        s.setStatus(`Estimating scene loudness ${p.done} / ${p.total}…`, false);
      }
    }
    // liascape-player's VRAM guard stopped a scene (not a crash — it stays playable): say why
    else if (e.type === "scene-vram-stopped") {
      const t = useStore.getState().libraryItems.find((i) => i.videoPath === e.payload.path)?.title ?? e.payload.path.split("/").pop();
      s.setStatus(`${t}: ${e.payload.message}`, true, true); // held: the rotation's switch off it lands right after
    }
    // a scene broke for good (liascape-player: past its restart budget) — the backend marked it crashed in its index:
    // its card shows it at once (it used to wait for the next library reload)
    else if (e.type === "scene-crashed") s.itemChangedByBackend(e.payload.path, { hasCrashed: true });
    // another client (a script, a second window) saved the playlist: a stale playlistBar would save itself back over it
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

  // FREEZE FIX: pause all gif animation when the window is hidden OR loses focus (you fullscreen
  // another app over it). On X11 an occluded window keeps reporting visible, so without this the
  // autoplay gifs decode forever in the background → ThreadPool backlog → eventual main-thread wedge.
  // focus/blur fire even when the window is merely occluded (another app took focus), unlike
  // visibilitychange. See store.appActive — gif `active` gates AND this.
  useEffect(() => {
    const sync = () => useStore.setState({ appActive: document.visibilityState === "visible" && document.hasFocus() });
    sync();
    for (const ev of ["visibilitychange", "focus", "blur"] as const) addEventListener(ev, sync, true);
    // authoritative WM signal from the Electron main process (preload window.liascape.onActiveChange) — fires
    // on real focus changes even when X11 occlusion keeps the DOM reporting "visible".
    (window as unknown as { liascape?: { onActiveChange?: (cb: (v: boolean) => void) => void } }).liascape?.onActiveChange?.(
      (v) => useStore.setState({ appActive: v }));
    return () => { for (const ev of ["visibilitychange", "focus", "blur"] as const) removeEventListener(ev, sync, true); };
  }, []);

  // ThumbnailAspect drives thumb aspect-ratio. Column count is per-container (useGridFit:
  // derived from window size + CardSize target count + aspect → constant visible count on resize).
  useEffect(() => {
    const aspect = ({ "1:1": "1 / 1", "16:9": "16 / 9", Default: "16 / 9" } as Record<string, string>)[(s.settings?.thumbnailAspect as string)] ?? "16 / 9";
    document.documentElement.style.setProperty("--thumb-aspect", aspect);
  }, [s.settings?.thumbnailAspect]);

  // Chrome (bars/modals/dropdowns) goes translucent ONLY when the live wallpaper is behind every tab;
  // otherwise it's fully opaque. Drives the :root.bg-live translucency vars (--tr / --tr-strong).
  useEffect(() => {
    document.documentElement.classList.toggle("bg-live", !!s.settings?.liveWallpaperBehindAllTabs);
  }, [s.settings?.liveWallpaperBehindAllTabs]);

  // Settings → Look & feel → "Glow effects": off = :root.no-glow, which index.css turns every glow off under (default on —
  // the class is set only once the saved settings say `false`)
  useEffect(() => {
    document.documentElement.classList.toggle("no-glow", s.settings?.glows === false);
  }, [s.settings?.glows]);
  // COOL: "Smooth window animations" off, or the OS asks for reduced motion → :root.no-motion: the tab slide and the
  // playlist bar's dock lift don't animate (index.css); the morphs read useMotion() themselves
  useEffect(() => { document.documentElement.classList.toggle("no-motion", !motion); }, [motion]);

  // Library-tab Import (parity: library action lives here, not buried in Settings).
  const onImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] as (File & { path?: string }) | undefined;
    if (f?.path) s.importFile(f.path, f.name.replace(/\.[^.]+$/, ""));
    e.target.value = "";
  };

  const src = s.sources[s.activeSource];
  const bgAllTabs = !!(s.settings?.liveWallpaperBehindAllTabs);
  return (
    <div className="app" ref={appRef} data-tab-dir={tabDir ?? undefined}>
      {/* live wallpaper behind the UI — Settings always, or every tab when the advanced toggle is on */}
      {(tab === "settings" || bgAllTabs) && <WallpaperBg />}
      <div className="topbar" ref={topbarRef}>
        <div className="tabs" style={{ "--tab-i": TAB_ORDER.indexOf(tab) } as React.CSSProperties}>
          <span className="tab-pill" aria-hidden />
          {TAB_ORDER.map((t) => (
            <button key={t} className={`tab${tab === t ? " active" : ""}`} onClick={() => setTab(t)}>
              {t[0].toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>

        {tab === "settings" && (
          <div className="pills level-pills" data-settings-level={levelOf(s.settings?.settingsLevel)} title="How much of Settings to show — hidden settings keep working">
            {LEVELS.map((l) => (
              <button key={l} className={`pill${levelOf(s.settings?.settingsLevel) === l ? " active" : ""}`} data-level={l} title={LEVEL_HINT[l]}
                onClick={() => s.setSetting("settingsLevel", l)}>{LEVEL_LABEL[l]}</button>
            ))}
          </div>
        )}
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
            {/* "Go to playing" (owner 2026-11-11): glides the grid to the playing wallpaper's card and rings it */}
            <button className="mini" data-go-playing="library" disabled={!s.playingPath}
              title={s.playingPath ? "Show the playing wallpaper in the library" : "Nothing is playing"}
              onClick={() => { if (!glideTo(document.querySelector<HTMLElement>(".lib-scroll"), ".card.playing", "y", motion)) s.setStatus("The playing wallpaper isn't in this view", true); }}>
              <LocateFixed size={16} /></button>
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

      {/* each grid view renders its own item sidebar next to its .scroll (components/SidePanel.tsx) */}
      <LayoutGroup>
        {tab === "browse" && <Browse onShowInLibrary={(p) => { s.focusLib(p); setTab("library"); }} />}
        {tab === "library" && <Library />}
        {tab === "settings" && <Suspense fallback={<div className="loadbar" />}><Settings /></Suspense>}

        {tab === "library" && <PlaylistBar />}

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
