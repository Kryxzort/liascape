import { Activity, memo, useCallback, useDeferredValue, useEffect, useRef, useState, lazy, Suspense } from "react";
import { LEVELS, LEVEL_LABEL, levelOf } from "./settingsLevel";
import { LayoutGroup } from "framer-motion";
import { LocateFixed, Square, Undo2, Upload } from "lucide-react";
import { glideTo } from "./hooks/travelToPlaying";
import { useStableFn } from "./hooks/useStableFn";
import { useStore } from "./store";
import { useEvents, type LiascapeEvent } from "./api/events";
import { Browse } from "./views/Browse";
import { Library } from "./views/Library";
import { PlaylistBar as PlaylistBarView } from "./components/PlaylistBar";
import { useMotion } from "./components/motion";
import { CLIENT_ID } from "./api/client";
import { startFreezeLog } from "./debug/freezeLog";
import { WallpaperBg } from "./components/WallpaperBg";
import { SortFilterButton } from "./components/SortFilterButton";
import { SourcePills } from "./components/SourcePills";
import { BUTTONS_NARROW, useNarrow } from "./hooks/useTopbarCompact";
import { WS_SORT_OPTIONS, wsSortPatch, wsSortValue } from "./components/workshopFilter";
import { Segmented } from "./components/Segmented";
import LibraryOpsLine from "./components/LibraryOpsLine";
// PERF: code-split the bits not on the first paint (Settings is the 3rd tab; Steam/Error/Drain are
// rarely-shown overlays; DebugHud only matters under LIASCAPE_DEBUG_IPC). Keeps the initial parse
// small + lets Electron's V8 code cache hit the stable vendor chunk across launches. The item sidebars stay eager (their
// views import them).
// PERF: memo'd like the other pages and the playlist bar: App reads the whole store, so without it every store change
// (a sidebar focus, a status line, a download tick) re-rendered the page — the playlist bar's every item with it
// (dnd-kit's context reaches each one past its memo). Guard: probe-layout perf:sidebar.
const Settings = memo(lazy(() => import("./views/Settings").then((m) => ({ default: m.Settings }))));
const PlaylistBar = memo(PlaylistBarView);
const SteamModal = lazy(() => import("./components/SteamModal").then((m) => ({ default: m.SteamModal })));
const SteamPasswordModal = lazy(() => import("./components/SteamPasswordModal").then((m) => ({ default: m.SteamPasswordModal })));
const DrainToast = lazy(() => import("./components/DrainToast").then((m) => ({ default: m.DrainToast })));
const SteamTodoPanel = lazy(() => import("./components/SteamTodoPanel").then((m) => ({ default: m.SteamTodoPanel })));
const ErrorModal = lazy(() => import("./components/ErrorModal").then((m) => ({ default: m.ErrorModal })));
const DebugHud = lazy(() => import("./debug/DebugHud").then((m) => ({ default: m.DebugHud })));

type Tab = "browse" | "library" | "settings";
const TAB_ORDER: Tab[] = ["browse", "library", "settings"];
const SORTS = ["Name A–Z", "Name Z–A", "Videos first", "Scenes first", "Newest", "Oldest"].map((l, i) => ({ value: String(i), label: l }));
const BROWSE_SORTS = ["Default", "Name A–Z", "Name Z–A", "Videos first", "Scenes first", "Newest", "Oldest"].map((l, i) => ({ value: String(i), label: l }));

export default function App() {
  const s = useStore();
  const motion = useMotion(); // "Smooth window animations" && !prefers-reduced-motion
  const narrow = useNarrow(BUTTONS_NARROW); // the top bar's labelled buttons show their icons only (index.css .tb-label)
  // COOL: the tab switch slides — the active pill glides under the tabs, the new page slides in from the side it's on
  // (index.css `.tab-pill`, `.app[data-tab-dir]`; transform + opacity only; :root.no-motion → the pill jumps, the page
  // fades in place). No direction until
  // the first switch, so the app's first page doesn't slide in.
  // PERF: `picked` is the tab the user chose — the pill and the tab's label follow it in the click's own frame; `tab` (the
  // page, its top-bar controls and the slide direction) follows it in a background render (useDeferredValue), which
  // React splits into short slices: building a page (the library's ~170 cards) no longer holds the click's frame, the
  // pill already glides meanwhile. The direction travels with the page: changing it under the old page would restart
  // its slide-in. Guard: probe-layout perf:tabs, tabs:slide.
  const [picked, setPicked] = useState<{ tab: Tab; dir: "l" | "r" | null }>({ tab: "library", dir: null });
  const shown = useDeferredValue(picked);
  const tab = shown.tab, tabDir = shown.dir;
  const setTab = (t: Tab) => {
    if (t !== picked.tab) setPicked({ tab: t, dir: TAB_ORDER.indexOf(t) > TAB_ORDER.indexOf(picked.tab) ? "r" : "l" });
  };
  // PERF: the Library page and the playlist bar stay mounted once shown, hidden (React's <Activity>: display none) while
  // another tab shows. A switch back reveals them instead of building their ~1,000 components and DOM again: about half the
  // missed frames of a switch, at 240 Hz and at 4× CPU / 60 Hz. Hidden, their effects are cleaned up (key handlers,
  // observers, timers: they listen to nothing), and leaving the page resets what a fresh one starts without
  // (hooks/useResetOnLeave.ts). Its sidebar stays mounted too: `data-page` (the tab shown) lets index.css dock only the shown
  // page's own. Browse and Settings are built on each visit, before the kept page in the document, so a query for the first
  // `.scroll` / card finds the page showing. Guard: probe-layout perf:tabs, tabs:keep
  const [libKept, setLibKept] = useState(tab === "library");
  if (tab === "library" && !libKept) setLibKept(true);
  const showInLibrary = useStableFn((p: string) => { s.focusLib(p); setTab("library"); });
  const importRef = useRef<HTMLInputElement>(null);

  useEffect(() => { s.init().catch(console.error); }, []); // eslint-disable-line
  useEffect(() => { startFreezeLog(); }, []); // diagnostic heartbeat → ~/.cache/liascape/freeze.log (catches the wedge)

  // backend push events → targeted store updates
  const onEvent = useCallback((e: LiascapeEvent) => {
    if (e.type === "download-progress") { s.setDownload(e.payload.id, e.payload.value, e.payload.status); if (e.payload.done) s.bumpWsState(); }
    // the Browse sidebar's Subscribe: its step while it runs, then the toggle re-reads its state
    else if (e.type === "subscribe-progress") {
      const p = e.payload;
      s.setSubProgress(p.id, p.done ? null : { value: p.value, status: p.status });
      if (p.done) { s.bumpWsState(); if (p.error) s.setStatus(`Subscribing failed: ${p.error}`); }
    }
    else if (e.type === "wallpaper-changed") s.setPlaying(e.payload.path);
    else if (e.type === "settings-changed") s.mergeSettings(e.payload);
    else if (e.type === "loop-current") { s.setKeepCurrent(e.payload.keep); s.setStatus(e.payload.message); }
    else if (e.type === "steam-qr") s.setQrPng(e.payload.png);
    else if (e.type === "steam-signed-in") s.onSignedIn(e.payload);
    else if (e.type === "steam-qr-error") s.setStatus("Steam: " + e.payload.message);
    // the password sign-in's steps (SteamPasswordModal)
    else if (e.type === "steam-login-code") s.onPwCode(e.payload);
    else if (e.type === "steam-login-error") s.onPwError(e.payload.message);
    else if (e.type === "unsub-progress") {
      s.setUnsub(e.payload.finished ? null : { done: e.payload.done, total: e.payload.total, currentId: e.payload.currentId, active: true });
      // no usable sign-in: the backend opened the item(s) in the Steam app — say what to click there (held, not a flash)
      if (e.payload.finished && e.payload.message) s.setStatus(e.payload.message, false);
      else if (e.payload.finished && e.payload.error) s.setStatus("Removing from Steam failed: " + e.payload.error);
      if (e.payload.finished) s.bumpWsState();
    }
    else if (e.type === "steam-todo") { s.setSteamTodo(e.payload); s.bumpWsState(); }
    else if (e.type === "library-synced") { s.loadLibrary(); s.bumpWsState(); }
    else if (e.type === "library-item-changed") { const { path, ...changed } = e.payload; s.itemChangedByBackend(path, changed); }
    // the library's background operations (the clip sweep, Steam's tags, frame sizes): the top bar's progress line
    else if (e.type === "library-ops") s.setLibraryOps(e.payload.ops);
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
    // its card shows it at once, not at the next library reload
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
    // only an explicit 16:9 is widescreen; before the settings load it's the real default, 1:1 (useGridFit's rule)
    const aspect = s.settings?.thumbnailAspect === "16:9" ? "16 / 9" : "1 / 1";
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
  // COOL: "Smooth window animations" off, or the OS asks for reduced motion → :root.no-motion: nothing moves, what appears,
  // leaves or swaps fades (index.css; docs/decisions.md § "Fade, never move, with motion off"); the morphs read useMotion()
  // The switch itself shows nothing: it swaps the name of every appear animation that already ran (the page's, an open
  // panel's, the Settings sections'), and CSS restarts a renamed animation — the page would fade or slide in again. So
  // what the switch just started is finished at once (loops excepted). Guard: probe-layout motion:switch
  useEffect(() => {
    const root = document.documentElement;
    if (root.classList.contains("no-motion") === !motion) return;
    root.classList.toggle("no-motion", !motion);
    for (const a of document.getAnimations())
      if (a.pending && a instanceof CSSAnimation && a.effect?.getTiming().iterations !== Infinity) a.finish();
  }, [motion]);

  // Library-tab Import (parity: library action lives here, not buried in Settings).
  const onImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] as (File & { path?: string }) | undefined;
    if (f?.path) s.importFile(f.path, f.name.replace(/\.[^.]+$/, ""));
    e.target.value = "";
  };

  const src = s.sources[s.activeSource];
  const bgAllTabs = !!(s.settings?.liveWallpaperBehindAllTabs);
  return (
    <div className="app" data-page={tab} data-tab-dir={tabDir ?? undefined}>
      {/* live wallpaper behind the UI — Settings always, or every tab when the advanced toggle is on */}
      {(tab === "settings" || bgAllTabs) && <WallpaperBg />}
      <div className="topbar">
        <div className="tabs" style={{ "--tab-i": TAB_ORDER.indexOf(picked.tab) } as React.CSSProperties}>
          <span className="tab-pill" aria-hidden />
          {TAB_ORDER.map((t) => (
            <button key={t} className={`tab${picked.tab === t ? " active" : ""}`} onClick={() => setTab(t)}>
              {t[0].toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>

        {tab === "settings" && (
          <Segmented className="level-pills" label="Settings level" attrs={{ "data-settings-level": levelOf(s.settings?.settingsLevel) }}
            value={levelOf(s.settings?.settingsLevel)} onChange={(l) => s.setSetting("settingsLevel", l)}
            options={LEVELS.map((l) => ({ value: l, label: LEVEL_LABEL[l], attrs: { "data-level": l } }))} />
        )}
        {tab === "browse" && <SourcePills />}

        <div className="spacer" />

        {/* status in the topbar: "Your downloaded wallpapers" (library) replaced by the active status + Undo */}
        {s.status
          ? <span className="status">{s.status}</span>
          : tab === "library" && <span className="status muted-status">Your downloaded wallpapers</span>}
        {s.undoDepth > 0 && <button className="btn ghost ico glow-pulse" aria-label="Undo" title={narrow ? "Undo" : undefined} onClick={() => s.undo()}><Undo2 size={14} /><span className="tb-label">Undo</span></button>}

        {/* Stop — red/danger with a soft glow */}
        {s.playingPath && <button className="btn danger ico glow-stop" aria-label="Stop" title={narrow ? "Stop" : undefined} onClick={() => s.stop()}><Square size={14} fill="currentColor" /><span className="tb-label">Stop</span></button>}

        {tab === "browse" && src?.supportsSearch && (
          <input className="search" placeholder={`Search ${src.name}…`} value={s.query}
            onChange={(e) => s.setQuery(e.target.value)} />
        )}
        {/* the filter panel's toggle + the sort, one split button (the Workshop's period is in its sort menu) */}
        {tab === "browse" && (
          <SortFilterButton page="browse" scope={s.browseScope()}
            sort={src?.supportsTagFilter ? { value: wsSortValue(s.browseFilter), options: WS_SORT_OPTIONS, onChange: (v) => s.setBrowseFilter(wsSortPatch(v)) }
              : src?.supportsSorting ? { value: String(s.browseSort), options: BROWSE_SORTS, onChange: (v) => s.setBrowseSort(+v) } : null} />
        )}
        {tab === "library" && (
          <>
            {/* "Go to playing": glides the grid to the playing wallpaper's card and rings it */}
            <button className="mini go-playing" data-go-playing="library" disabled={!s.playingPath}
              title={s.playingPath ? "Show the playing wallpaper in the library" : "Nothing is playing"}
              onClick={() => { if (!glideTo(document.querySelector<HTMLElement>(".lib-scroll"), ".card.playing", "y", motion)) s.setStatus("The playing wallpaper isn't in this view", true); }}>
              <LocateFixed size={16} /></button>
            <button className="btn ghost ico" aria-label="Import" title={narrow ? "Import" : undefined} onClick={() => importRef.current?.click()}><Upload size={14} /><span className="tb-label">Import</span></button>
            <input ref={importRef} type="file" accept=".mp4,.webm,.mov,.mkv,.avi,.gif,.png,.jpg,.jpeg,.webp"
              style={{ display: "none" }} onChange={onImportFile} />
            <input className="search" placeholder="Search library…" value={s.libQuery}
              onChange={(e) => s.setLibQuery(e.target.value)} />
            <SortFilterButton page="library" scope={s.libraryItems.length ? "library" : null}
              sort={{ value: String(s.libSort), options: SORTS, onChange: (v) => s.setLibSort(+v) }} />
          </>
        )}
      </div>

      {s.loading && <div className="loadbar" />}
      <LibraryOpsLine />

      {/* each grid view renders its own item sidebar next to its .scroll (components/SidePanel.tsx) */}
      <LayoutGroup>
        {tab === "browse" && <Browse onShowInLibrary={showInLibrary} />}
        {tab === "settings" && <Suspense fallback={<div className="loadbar" />}><Settings /></Suspense>}
        {libKept && <Activity mode={tab === "library" ? "visible" : "hidden"}><Library /></Activity>}

        {libKept && <Activity mode={tab === "library" ? "visible" : "hidden"}><PlaylistBar /></Activity>}

      </LayoutGroup>
      <Suspense fallback={null}>
        <SteamModal />
        <SteamPasswordModal />
        <DrainToast />
        <SteamTodoPanel />
        <ErrorModal />
        <DebugHud setTab={(t) => setTab(t as Tab)} getScroll={() => document.querySelector<HTMLElement>(".scroll")} />
      </Suspense>
    </div>
  );
}
