import { create } from "zustand";
import { captureSource, type MorphSource } from "../components/morph";
import {
  api, type Source, type Wallpaper, type Theme, type LibraryItem, type PlaylistSettings, type WorkshopFilter,
} from "../api/client";

const DEFAULT_FILTER: WorkshopFilter = { sort: "trend", trendDays: 7, type: "", ageRating: "", resolution: "", genres: [], features: [] };

// persist browse view-state (source / filter / sort) across restarts — pure UI prefs, so localStorage
// (survives in Electron) rather than the backend settings.json.
const LS = {
  get<T>(k: string, d: T): T { try { const v = localStorage.getItem("liascape." + k); return v == null ? d : (JSON.parse(v) as T); } catch { return d; } },
  set(k: string, v: unknown) { try { localStorage.setItem("liascape." + k, JSON.stringify(v)); } catch { /* ignore */ } },
};

// Applies a theme's 16 colors to :root as CSS vars (ThemeService color keys).
// COOL: --accent also drives every glow in the app.
function applyThemeVars(t: Theme) {
  const r = document.documentElement.style;
  const set = (k: string, v: string) => r.setProperty(k, v);
  set("--bg-base", t.bgBase); set("--bg-mantle", t.bgMantle); set("--bg-crust", t.bgCrust);
  set("--surface0", t.surface0); set("--surface1", t.surface1); set("--surface2", t.surface2);
  set("--text", t.textColor); set("--subtext", t.subtext); set("--muted", t.muted);
  set("--accent", t.accent); set("--accent-fg", t.accentFg); set("--accent-hover", t.accentHover);
  set("--danger", t.danger); set("--danger-bg", t.dangerBg); set("--success", t.success);
}

const DEFAULT_PS: PlaylistSettings = {
  order: 0, overrideGlobalSettings: false, intervalSeconds: 0, switchWhenVideoEnds: true, maxPlaySeconds: 0,
  separateSceneTiming: true, switchScenesAfterSeconds: 1800,
  transitionEnabled: false, transitionEffectIds: [], transitionDurationMs: 600, transitionDurationMaxMs: 0, transitionShuffle: true,
};

interface State {
  // browse
  sources: Source[]; activeSource: number; wallpapers: Wallpaper[]; page: number;
  loading: boolean; query: string; hasMore: boolean; downloads: Record<string, number>;
  browseFilter: WorkshopFilter; browseSort: number;
  // library
  libraryItems: LibraryItem[]; libQuery: string; libSort: number; undoDepth: number;
  // playlist
  playlist: string[]; playlistSettings: PlaylistSettings; playlistName: string | null; playlistNames: string[];
  // steam / workshop
  steam: { signedIn: boolean; accountName: string; daysLeft: number | null; mode: string } | null;
  qrOpen: boolean; qrPng: string | null;
  unsub: { done: number; total: number; currentId: string; active: boolean } | null;
  // shared
  themes: Theme[]; theme: Theme | null; settings: Record<string, unknown> | null; playingPath: string | null;
  status: string; error: string | null;
  // per-wallpaper settings modal (lifted so library cards AND the playlist bar can open it)
  cardSettingsItem: LibraryItem | null; cardSettingsSiblings: LibraryItem[];
  cardSettingsMorphId: string | null; // the surface the modal morphs FROM/back to (`data-morph-id`: lib-… or pl-…) — hidden while open
  cardSettingsSource: MorphSource | null; // that surface's picture state at the click (components/morph.ts)
  // PERF/FREEZE: false when the window is hidden OR unfocused (you fullscreened another app over it).
  // On X11 an occluded window often never fires visibilitychange, so Chromium keeps decoding all the
  // autoplay gifs for hours → ThreadPool decode backlog saturates → main thread stalls (futex_wait) →
  // frozen UI on return. Gating gif mounts on this unmounts them when backgrounded → no decode drain.
  appActive: boolean;

  init(): Promise<void>;
  resync(): Promise<boolean>;
  // browse
  setSource(i: number): void; setQuery(q: string): void; reload(): Promise<void>; loadMore(): Promise<void>;
  setBrowseFilter(p: Partial<WorkshopFilter>): void; isWorkshop(): boolean; setBrowseSort(i: number): void;
  download(source: number, w: Wallpaper, apply: boolean): Promise<void>;
  cancelDownload(id: string): void;
  setDownload(id: string, v: number): void;
  stop(): Promise<void>; resetAllSettings(): void;
  addManyToPlaylist(paths: string[]): void; removeManyFromPlaylist(paths: string[]): void;
  steamcmdSignin(): void; setError(e: string): void; dismissError(): void;
  // library
  loadLibrary(): Promise<void>; applyItem(path: string): Promise<void>;
  patchLibraryItem(path: string, partial: Partial<LibraryItem>): void;
  itemChangedByBackend(path: string, partial: Partial<LibraryItem>): void;
  trashItems(items: LibraryItem[]): Promise<void>; undo(): Promise<void>;
  setLibQuery(q: string): void; setLibSort(i: number): void;
  // playlist
  inPlaylist(path: string): boolean; toggleInPlaylist(path: string): void; removeFromPlaylist(path: string): void;
  syncPlaylist(): Promise<void>; reorderPlaylist(from: number, to: number): void; playPlaylist(): Promise<void>; playFrom(index: number): Promise<void>;
  setPlaylistSettings(p: Partial<PlaylistSettings>): void;
  savePlaylistAs(name: string): Promise<void>; loadNamedPlaylist(name: string): Promise<void>;
  // settings
  setSetting(key: string, value: unknown): void; mergeSettings(p: Record<string, unknown>): void;
  clearLibrary(): Promise<void>; clearCache(): Promise<void>;
  importFile(path: string, title: string): Promise<void>;
  // steam / workshop
  loadSteam(): Promise<void>; startQr(): Promise<void>; cancelQr(): Promise<void>; signoutSteam(): Promise<void>;
  deleteFromSource(items: LibraryItem[]): Promise<void>; drain(): Promise<void>;
  setQrPng(png: string): void; onSignedIn(s: State["steam"]): void;
  setUnsub(u: State["unsub"]): void;
  openExternal(body: { path?: string; url?: string; reveal?: boolean; isScene?: boolean; workshopId?: string | null; copiedSceneDir?: string | null }): void;
  openCardSettings(item: LibraryItem, siblings?: LibraryItem[], morphId?: string): void; closeCardSettings(): void;
  // shared
  applyTheme(name: string): void; setPlaying(p: string | null): void; setStatus(s: string, timed?: boolean, hold?: boolean): void;
  refreshPlayingStatus(): void;
}

let searchTimer: ReturnType<typeof setTimeout>;
let filterTimer: ReturnType<typeof setTimeout>;
let stateTimer: ReturnType<typeof setTimeout>;
let settingsTimer: ReturnType<typeof setTimeout>;
let statusTimer: ReturnType<typeof setTimeout>;
let statusHeldUntil = 0;
// a playlist bar / settings edit whose debounced save hasn't fired yet: a resync keeps the local copy (that save is on its way)
let playlistBarSavePending = false;
let settingsSavePending = false;
let resyncing: Promise<boolean> | null = null;
let resyncAgain = false;
const dlCtrls: Record<string, AbortController> = {}; // per-download abort (cancel)

// Reset-to-defaults for the playback/mpv fields.
// Mirrors AppSettings defaults (the user-editable subset — NOT daemon-owned fields like lastSession
// or steam tokens). Used for the per-setting reset icon + "Clear settings". workshopFolder is
// environment-derived so it's intentionally omitted (no fixed default to reset to).
export const SETTINGS_DEFAULTS: Record<string, unknown> = {
  loop: true, noAudio: true, disableCache: false, advancedSettings: false, videoFpsCap: 0, liveWallpaperBehindAllTabs: false,
  debugMode: false, debugOverlay: true, restartOnlyAtPlaylistChangeover: false, stayPausedWhenSwitching: false, replaceDirectWithWorkshop: false, volume: 100, speed: 1, restartMpvpaperEverySeconds: 600, normalizeAudio: false, normalizeTargetLufs: -14,
  globalSwitchWhenVideoEnds: true, globalIntervalSeconds: 0, globalMaxPlaySeconds: 0, autoAddLibraryToPlaylist: false,
  globalSeparateSceneTiming: true, globalSwitchScenesAfterSeconds: 1800,
  globalTransitionEnabled: false, globalTransitionEffectIds: [], globalTransitionDurationMs: 600, globalTransitionDurationMaxMs: 0, globalTransitionShuffle: true, transitionMethod: "reveal", fullLiveSyncOffsetMs: -30,
  autoMute: false, autoMuteOnlyIfMprisActive: false, autoMuteDelayMs: 200, autoUnmuteDelayMs: 2000, autoMuteMinLevelDb: -70,
  hwDec: "auto", videoScale: "fill", demuxerMaxMib: 20, demuxerMaxBackMib: 5, playerEngine: "legacy",
  autoThrottleScenes: true, limitVramPerScene: false, sceneVramLimitMib: 1536, vramLowMode: "stop",
  thumbnailAspect: "1:1", cardSize: "Medium", autoPlayGifs: false,
  copyFilesInsteadOfSymlinking: false, allowScenes: false, autoAddWeWallpapersToLibrary: false, sceneTransitionDelayMs: 1000, sceneMonitors: [],
  workshopDownloadMode: "subscribe", steamCmdPath: "", steamUsername: "",
  resumeFromLast: true, theme: "Catppuccin Mocha",
};

export const useStore = create<State>((set, get) => ({
  sources: [], activeSource: 0, wallpapers: [], page: 1, loading: false, query: "", hasMore: true, downloads: {},
  browseFilter: { ...DEFAULT_FILTER, ...LS.get<Partial<WorkshopFilter>>("browseFilter", {}) }, browseSort: LS.get("browseSort", 0),
  libraryItems: [], libQuery: "", libSort: LS.get("libSort", 5), undoDepth: 0,
  playlist: [], playlistSettings: DEFAULT_PS, playlistName: null, playlistNames: [],
  steam: null, qrOpen: false, qrPng: null, unsub: null,
  themes: [], theme: null, settings: null, playingPath: null, status: "", error: null,
  cardSettingsItem: null, cardSettingsSiblings: [], cardSettingsMorphId: null, cardSettingsSource: null, appActive: true,

  // The backend may be unreachable right now: restarting (`dotnet watch` on a source change — whose HMR update re-runs
  // this init into that very gap — or a relaunch). Retry until it answers; a read that failed never becomes what the
  // page shows (init used to take a failed /library as [] → "Library is empty" for good while a wallpaper played).
  async init() {
    for (let i = 0; !(await get().resync()); i++) await new Promise((r) => setTimeout(r, Math.min(250 * 2 ** i, 2000)));
    await get().reload();
  },
  // API: everything the page mirrors from the backend, read as one — at start (init) and after every WS reconnect
  // (App.tsx: a backend restart or any gap in the push events — what changed meanwhile was never pushed). Each piece
  // is applied only when ITS read succeeded; a failed one keeps what's shown. true = no read failed for want of a
  // backend (an HTTP error from a live one isn't retried). Overlapping calls coalesce into one more pass.
  async resync() {
    if (resyncing) { resyncAgain = true; return resyncing; }
    resyncing = (async () => {
      let ok: boolean;
      do { resyncAgain = false; ok = await readBackend(set, get); } while (resyncAgain);
      return ok;
    })().finally(() => { resyncing = null; });
    return resyncing;
  },

  // ---- browse ----
  setSource(i) { set({ activeSource: i }); LS.set("activeSource", i); get().reload(); },
  setQuery(q) { set({ query: q }); clearTimeout(searchTimer); searchTimer = setTimeout(() => get().reload(), 200); },
  isWorkshop() { return !!get().sources[get().activeSource]?.supportsTagFilter; },
  // update the filter instantly (UI is snappy) but DEBOUNCE the network reload — rapid chip toggles
  // would otherwise fire a full refetch + grid re-render each → laggy.
  setBrowseFilter(p) { const bf = { ...get().browseFilter, ...p }; set({ browseFilter: bf }); LS.set("browseFilter", bf); clearTimeout(filterTimer); filterTimer = setTimeout(() => get().reload(), 280); },
  setBrowseSort(i) { set({ browseSort: i }); LS.set("browseSort", i); }, // client-side (WE-local; single page)
  async reload() {
    const { activeSource, query } = get();
    const filter = get().isWorkshop() ? get().browseFilter : undefined;
    set({ loading: true, page: 1 });
    try {
      const list = await api.browse(activeSource, 1, query || undefined, filter);
      set({ wallpapers: list, hasMore: !!get().sources[activeSource]?.supportsPagination && list.length > 0 });
    } finally { set({ loading: false }); }
  },
  async loadMore() {
    const { activeSource, query, page, loading, hasMore, wallpapers } = get();
    if (loading || !hasMore) return;
    const filter = get().isWorkshop() ? get().browseFilter : undefined;
    set({ loading: true });
    try {
      const next = page + 1;
      const list = await api.browse(activeSource, next, query || undefined, filter);
      // Dedup by pageUrl — "Most Popular" et al. shift between requests, so pages overlap
      // pages overlap; appending dupes = duplicate React keys → reorder/jump. Keep existing order, add
      // only fresh items at the bottom, and stop when a page yields nothing new.
      const existing = new Set(wallpapers.map((w) => w.pageUrl));
      const fresh = list.filter((w) => !existing.has(w.pageUrl));
      if (fresh.length === 0) { set({ page: next, hasMore: false }); return; }
      set({ wallpapers: [...wallpapers, ...fresh], page: next, hasMore: list.length > 0 });
    } finally { set({ loading: false }); }
  },
  async download(source, w, apply) {
    const ctrl = new AbortController(); dlCtrls[w.pageUrl] = ctrl;
    set({ downloads: { ...get().downloads, [w.pageUrl]: 0 } });
    try {
      const item = await api.download(source, w, apply, ctrl.signal);
      if ("error" in item && item.error) { get().setError(`Download failed: ${item.error}`); return; }
      await get().loadLibrary();
      get().setStatus(apply ? `Applied: ${w.title}` : `Downloaded: ${w.title}`);
    } catch (e) {
      if (ctrl.signal.aborted) get().setStatus(`Cancelled: ${w.title}`);
      else get().setError(`Download failed: ${(e as Error).message}`); // error modal
    } finally { delete dlCtrls[w.pageUrl]; const d = { ...get().downloads }; delete d[w.pageUrl]; set({ downloads: d }); }
  },
  cancelDownload(id) { dlCtrls[id]?.abort(); }, // cancel an in-flight download
  setDownload(id, v) { set({ downloads: { ...get().downloads, [id]: v } }); },
  async stop() { await api.stop(); set({ playingPath: null }); get().setStatus("Stopped"); },
  resetAllSettings() {
    // spread defaults over current → preserves daemon-owned fields (lastSession, steam tokens) the
    // backend also guards; re-applies the default theme's CSS vars (settings.theme alone won't).
    const s = { ...(get().settings ?? {}), ...SETTINGS_DEFAULTS };
    set({ settings: s }); api.saveSettings(s).catch(() => {});
    get().applyTheme(SETTINGS_DEFAULTS.theme as string);
    get().setStatus("Settings cleared — reset to defaults");
  },
  addManyToPlaylist(paths) {
    const set0 = new Set(get().playlist);
    set({ playlist: [...get().playlist, ...paths.filter((p) => !set0.has(p))] }); savePlaylistDebounced(get);
  },
  removeManyFromPlaylist(paths) {
    const rm = new Set(paths);
    set({ playlist: get().playlist.filter((p) => !rm.has(p)) }); savePlaylistDebounced(get);
  },
  steamcmdSignin() { api.steamcmdSignin().then(() => get().setStatus("steamcmd sign-in launched in terminal")).catch((e) => get().setError(String(e))); },
  setError(e) { set({ error: e }); },
  dismissError() { set({ error: null }); },

  // ---- library ----
  async loadLibrary() { set({ libraryItems: await api.library(), undoDepth: (await api.undoDepth()).depth }); },
  // optimistic per-item patch (volume/speed override etc.) so consumers — incl. the live WallpaperBg —
  // reflect a change instantly without waiting for a full library reload.
  patchLibraryItem(path, partial) { set((s) => ({ libraryItems: s.libraryItems.map((i) => i.videoPath === path ? { ...i, ...partial } : i) })); },
  // API: `library-item-changed` — the backend changed an item itself (a volume keybind on a wallpaper with its
  // own volume, `VolumeKeyTarget`): the grid's copy AND an open settings modal's (it re-inits from cardSettingsItem),
  // else the modal shows — and its next slider save restores — the old value
  itemChangedByBackend(path, partial) {
    const p = (i: LibraryItem) => (i.videoPath === path ? { ...i, ...partial } : i);
    set((s) => ({ libraryItems: s.libraryItems.map(p), cardSettingsItem: s.cardSettingsItem && p(s.cardSettingsItem), cardSettingsSiblings: s.cardSettingsSiblings.map(p) }));
  },
  async applyItem(path) {
    await api.apply(path); set({ playingPath: path });
    const t = get().libraryItems.find((i) => i.videoPath === path)?.title ?? (path.split("/").pop() ?? "").replace(/\.[^.]+$/, "");
    get().setStatus(`Applied: ${t}`);
  },
  // API: the backend takes trashed items out of the playlist (live, undo puts them back) — drop them
  // here first so a pending playlistBar save can't put them back, then take the backend's playlist.
  async trashItems(items) {
    if (items.length === 0) return;
    const gone = new Set(items.map((i) => i.videoPath));
    set({ playlist: get().playlist.filter((p) => !gone.has(p)) });
    await api.trash(items);
    await Promise.all([get().loadLibrary(), get().syncPlaylist()]);
    const n = items.length;
    get().setStatus(n > 1 ? `Deleted ${n} wallpapers` : `Deleted: ${items[0].title}`);
  },
  async undo() {
    const r = await api.undo();
    if (!r.ok) return;
    await Promise.all([get().loadLibrary(), get().syncPlaylist()]);
    get().setStatus(r.count > 1 ? `Restored ${r.count} wallpapers` : `Restored: ${r.title ?? ""}`);
  },
  setLibQuery(q) { set({ libQuery: q }); },
  setLibSort(i) { set({ libSort: i }); LS.set("libSort", i); },

  // ---- playlist ----
  async syncPlaylist() { const p = await api.playlistState().catch(() => null); if (p) set({ playlist: p.videoPaths }); },
  inPlaylist(path) { return get().playlist.includes(path); },
  toggleInPlaylist(path) {
    const p = get().playlist;
    set({ playlist: p.includes(path) ? p.filter((x) => x !== path) : [...p, path] });
    savePlaylistDebounced(get);
  },
  removeFromPlaylist(path) { set({ playlist: get().playlist.filter((x) => x !== path) }); savePlaylistDebounced(get); },
  reorderPlaylist(from, to) {
    const p = [...get().playlist]; const [m] = p.splice(from, 1); p.splice(to, 0, m);
    set({ playlist: p }); savePlaylistDebounced(get);
  },
  async playPlaylist() {
    const { playlist, playlistSettings } = get();
    if (playlist.length === 0) { get().setStatus("Playlist is empty"); return; }
    const r = await api.playPlaylist(playlist, playlistSettings);
    if (r.message) { get().setStatus(r.message); return; }   // error/interval messages
    set({ playingPath: playlist[0] }); get().refreshPlayingStatus(); // persistent now-playing line
  },
  async playFrom(index) {
    const { playlist, playlistSettings } = get();
    const r = await api.playFrom(playlist, index, playlistSettings);
    if (r.message) { get().setStatus(r.message); return; }
    set({ playingPath: playlist[index] }); get().refreshPlayingStatus();
  },
  setPlaylistSettings(p) {
    set({ playlistSettings: { ...get().playlistSettings, ...p } }); savePlaylistDebounced(get);
    if (get().playingPath) get().refreshPlayingStatus();
  },
  async savePlaylistAs(name) {
    await api.savePlaylist(name, { videoPaths: get().playlist, settings: get().playlistSettings, name });
    set({ playlistName: name, playlistNames: await api.playlistNames() });
    get().setStatus(`Saved playlist "${name}"`);
  },
  async loadNamedPlaylist(name) {
    const p = await api.loadPlaylist(name);
    if (p) {
      set({ playlist: p.videoPaths, playlistSettings: p.settings, playlistName: name }); savePlaylistDebounced(get);
      get().setStatus(`Loaded playlist "${name}" (${p.videoPaths.length} wallpapers)`);
    }
  },

  // ---- settings ----
  // API: `settings-changed` — the backend changed settings itself (a keybind's volume-up/down). Every UI
  // save posts the whole object, so the store must hold the new values or the next save reverts them.
  mergeSettings(p) {
    set({ settings: { ...(get().settings ?? {}), ...p } });
    if (get().playingPath) get().refreshPlayingStatus();
  },
  setSetting(key, value) {
    const s = { ...(get().settings ?? {}), [key]: value };
    set({ settings: s });
    clearTimeout(settingsTimer); settingsSavePending = true;
    // saves what the store holds THEN (not this snapshot): a backend change merged meanwhile survives
    settingsTimer = setTimeout(() => { settingsSavePending = false; api.saveSettings(get().settings ?? s).catch(() => {}); }, 250);
    // vol/loop/speed/rotation changes refresh the now-playing line live
    if (get().playingPath && ["volume", "noAudio", "loop", "speed", "globalSwitchWhenVideoEnds", "globalIntervalSeconds", "globalMaxPlaySeconds",
      "globalSeparateSceneTiming", "globalSwitchScenesAfterSeconds"].includes(key))
      get().refreshPlayingStatus();
  },
  async clearLibrary() { await api.libraryClear(); await get().loadLibrary(); get().setStatus("Library cleared"); },
  async clearCache() {
    try { const r = await api.clearCache(); get().setStatus(`Cache cleared — freed ${(r.freedBytes / (1 << 20)).toFixed(0)} MB (${r.count} files)`); }
    catch { get().setStatus("Failed to clear cache"); }
  },
  async importFile(path, title) {
    try { await api.importFile(path, title); await get().loadLibrary(); get().setStatus(`Imported: ${title}`); }
    catch (e) { get().setStatus(`Import failed: ${(e as Error).message}`); }
  },

  // ---- steam / workshop ----
  async loadSteam() { set({ steam: await api.steamStatus() }); },
  async startQr() { set({ qrOpen: true, qrPng: null }); await api.qrStart(); },
  async cancelQr() { await api.qrCancel(); set({ qrOpen: false, qrPng: null }); },
  async signoutSteam() { await api.signout(); await get().loadSteam(); },
  async deleteFromSource(items) {
    if (items.length === 0) return;
    await api.deleteFromSource(items); await get().loadLibrary();
    get().setStatus(`Deleting ${items.length} from Steam`);
    get().drain();
  },
  async drain() { set({ unsub: { done: 0, total: 0, currentId: "", active: true } }); await api.drain(); },
  setQrPng(png) { set({ qrPng: png }); },
  onSignedIn(s) { set({ steam: s, qrOpen: false, qrPng: null }); get().setStatus("Signed in to Steam"); },
  setUnsub(u) { set({ unsub: u }); },

  openExternal(body) { api.open(body).catch(() => {}); },

  openCardSettings(item, siblings, morphId) {
    set({ cardSettingsItem: item, cardSettingsSiblings: siblings ?? [item], cardSettingsMorphId: morphId ?? null, cardSettingsSource: captureSource(morphId ?? null) });
  },
  closeCardSettings() { set({ cardSettingsItem: null, cardSettingsSiblings: [], cardSettingsMorphId: null, cardSettingsSource: null }); get().loadLibrary(); },

  // ---- shared ----
  applyTheme(name) {
    const theme = get().themes.find((t) => t.name === name);
    if (!theme) return;
    applyThemeVars(theme); set({ theme });
    const s = { ...(get().settings ?? {}), theme: name };
    set({ settings: s }); api.saveSettings(s).catch(() => {});
  },
  setPlaying(p) { set({ playingPath: p }); get().refreshPlayingStatus(); },
  // Transient status message for 5s, then revert to the now-playing line.
  // `hold`: a notice the now-playing line mustn't replace before its 5 s are up (the switch it caused lands right after it)
  setStatus(s, timed = true, hold = false) {
    clearTimeout(statusTimer);
    set({ status: s });
    statusHeldUntil = hold && timed && s ? Date.now() + 5000 : 0;
    if (timed && s) statusTimer = setTimeout(() => { statusHeldUntil = 0; if (get().status === s) set({ status: buildPlayingStatus(get) }); }, 5000);
  },
  // Persistent "now playing" line (no auto-clear) — after a held notice's time is up (its own timer then shows it)
  refreshPlayingStatus() { if (Date.now() < statusHeldUntil) return; clearTimeout(statusTimer); set({ status: buildPlayingStatus(get) }); },
}));

// Format an interval (e.g. "1h 30m", "45s").
function fmtInterval(total: number): string {
  const p: string[] = []; const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  if (h) p.push(`${h}h`); if (m) p.push(`${m}m`); if (s || !p.length) p.push(`${s}s`);
  return p.join(" ");
}
// Now-playing line — playlist/wallpaper • Vol% • Loop • speed×.
function buildPlayingStatus(get: () => State): string {
  const st = get();
  if (!st.playingPath) return "";
  const set = st.settings ?? {};
  const titleOf = (p: string) => st.libraryItems.find((i) => i.videoPath === p)?.title
    ?? (p.split("/").pop() ?? "").replace(/\.[^.]+$/, "");
  const parts: string[] = [];
  const pl = st.playlist, ps = st.playlistSettings;
  const inPl = pl.length > 1 && pl.includes(st.playingPath);
  const advance = ps.overrideGlobalSettings ? ps.switchWhenVideoEnds : ((set.globalSwitchWhenVideoEnds as boolean) ?? true);
  const interval = ps.overrideGlobalSettings ? ps.intervalSeconds : ((set.globalIntervalSeconds as number) ?? 0);
  const maxPlay = ps.overrideGlobalSettings ? ps.maxPlaySeconds : ((set.globalMaxPlaySeconds as number) ?? 0);
  const sepScenes = ps.overrideGlobalSettings ? (ps.separateSceneTiming ?? true) : ((set.globalSeparateSceneTiming as boolean) ?? true);
  const scenesAfter = ps.overrideGlobalSettings ? (ps.switchScenesAfterSeconds ?? 1800) : ((set.globalSwitchScenesAfterSeconds as number) ?? 1800);
  const shuffle = ps.order === 1;
  const cur = titleOf(st.playingPath);
  if (inPl) {
    // advance-on-end: the interval is the minimum play time (player-adapter.md § Rotation)
    let desc = advance
      ? `${pl.length} wallpapers, on video end${interval > 0 ? `, at least ${fmtInterval(interval)}` : ""}${maxPlay > 0 ? `, at most ${fmtInterval(maxPlay)}` : ""}`
        + (sepScenes ? (scenesAfter > 0 ? `, scenes after ${fmtInterval(scenesAfter)}` : ", scenes stay") : "")
      : `${pl.length} wallpapers, every ${fmtInterval(interval)}`;
    if (shuffle) desc += " (shuffled)";
    if (cur) desc += ` → ${cur}`;
    parts.push(desc);
  } else if (cur) {
    parts.push(cur);
  }
  const vol = (set.volume as number) ?? 100;
  parts.push(set.noAudio ? `Vol ${vol}% (muted)` : `Vol ${vol}%`);
  if ((set.loop as boolean) ?? true) parts.push("Loop");
  const spd = (set.speed as number) ?? 1;
  if (Math.abs(spd - 1) > 0.01) parts.push(`${spd}×`);
  return parts.join(" • ");
}

function savePlaylistDebounced(get: () => State) {
  clearTimeout(stateTimer); playlistBarSavePending = true;
  stateTimer = setTimeout(() => {
    playlistBarSavePending = false;
    const { playlist, playlistSettings, playlistName } = get();
    api.savePlaylistState({ videoPaths: playlist, settings: playlistSettings, name: playlistName }).catch(() => {});
  }, 200);
}

// One read of everything the store mirrors (resync). A read fails → null → that piece stays as shown. Only the core
// reads decide "unreachable" (a fetch TypeError — no answer, or cross-origin dev: an answer without CORS headers): a
// side read that keeps failing (playlist names, undo depth, Steam status) must not keep init retrying forever.
type Setter = (p: Partial<State>) => void;
async function readBackend(set: Setter, get: () => State): Promise<boolean> {
  let unreachable = false;
  const r = <T,>(p: Promise<T>, core = true) => p.then((v) => ({ v }), (e) => { if (core && e instanceof TypeError) unreachable = true; return null; });
  const [sources, themes, settings, cur, lib, pstate, names, depth, steam] = await Promise.all([
    r(api.sources()), r(api.themes()), r(api.settings()), r(api.current()), r(api.library()), r(api.playlistState()),
    r(api.playlistNames(), false), r(api.undoDepth(), false), r(api.steamStatus(), false),
  ]);
  const st = get();
  const playingLine = st.status === "" || st.status === buildPlayingStatus(get); // no transient notice showing
  const p: Partial<State> = {};
  if (sources) {
    p.sources = sources.v;
    if (!st.sources.length) { // first load: restore the saved source if it's still available, else the first available
      const saved = LS.get<number>("activeSource", -1);
      const avail = new Set(sources.v.filter((x) => x.available).map((x) => x.index));
      p.activeSource = avail.has(saved) ? saved : (sources.v.find((x) => x.available)?.index ?? 0);
    }
  }
  if (themes) p.themes = themes.v;
  if (settings && !settingsSavePending) p.settings = settings.v;
  const tl = p.themes ?? st.themes, ss = p.settings ?? st.settings;
  if (tl.length && ss) {
    const name = (ss.theme as string) || tl[0]?.name;
    const theme = tl.find((t) => t.name === name) ?? tl[0] ?? null;
    if (theme) { applyThemeVars(theme); p.theme = theme; }
  }
  if (cur) p.playingPath = cur.v?.path ?? null;
  if (lib) p.libraryItems = lib.v;
  if (pstate && !playlistBarSavePending) {
    p.playlist = pstate.v?.videoPaths ?? []; p.playlistSettings = pstate.v?.settings ?? DEFAULT_PS; p.playlistName = pstate.v?.name ?? null;
  }
  if (names) p.playlistNames = names.v;
  if (depth) p.undoDepth = depth.v.depth;
  if (steam) p.steam = steam.v;
  set(p);
  if (playingLine) get().refreshPlayingStatus(); // the now-playing line follows (a transient notice reverts to it itself)
  return !unreachable;
}
