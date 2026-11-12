import { create } from "zustand";
import {
  steamPageUrl, api, type Source, type Wallpaper, type Theme, type LibraryItem, type PlaylistSettings, type WorkshopFilter, type SteamTodo,
  type LibraryOp,
} from "../api/client";

// what the item sidebar's picture shows (SideMedia's preview switch): the gif / webp, a video, the YouTube trailer, or the still
export type PreviewKind = "gif" | "video" | "youtube" | "image";

// what the backend gets: the filter without the UI-only "@" pseudo-tags (workshopFilter.ts LIBRARY_TAG)
const wireFilter = (f: WorkshopFilter): WorkshopFilter =>
  ({ ...f, include: f.include.filter((t) => !t.startsWith("@")), exclude: f.exclude.filter((t) => !t.startsWith("@")) });
// the filter panel docks beside the grid from this width; below it, it floats over the grid. The item sidebar's own breakpoint
// (index.css `.side-panel`): the two take turns on the right, so a swap between them never changes the grid.
export const WF_DOCK_QUERY = "(min-width: 900px)";
export type FilterPage = "browse" | "library";
const DEFAULT_FILTER: WorkshopFilter = { sort: "trend", trendDays: 7, include: [], exclude: [], featureMatch: "all", genreMatch: "any" };

// persist browse view-state (source / filter / sort) across restarts — pure UI prefs, so localStorage
// (survives in Electron) rather than the backend settings.json.
const LS = {
  get<T>(k: string, d: T): T { try { const v = localStorage.getItem("liascape." + k); return v == null ? d : (JSON.parse(v) as T); } catch { return d; } },
  set(k: string, v: unknown) { try { localStorage.setItem("liascape." + k, JSON.stringify(v)); } catch { /* ignore */ } },
};

// the saved Workshop filter: include / exclude tag sets (the filter column). An older saved filter's one-of picks (type /
// ageRating / resolution, the genre / feature chips) all become includes, once (the
// migrated filter is written back). Anything malformed -> the default.
export type TagState = "inc" | "exc" | null;
// The filter column's three homes, each with its own filter (saved under its own key): the Workshop's goes to the backend,
// the local Wallpaper Engine folder's and the Library's filter what the page already holds (workshopFilter.ts localMatcher)
export type FilterScope = "workshop" | "weLocal" | "library";
export const FILTER_KEY: Record<FilterScope, string> = { workshop: "browseFilter", weLocal: "weLocalFilter", library: "libFilter" };
type OldFilter = Partial<WorkshopFilter> & { type?: string; ageRating?: string; resolution?: string; genres?: string[]; features?: string[] };
export function loadBrowseFilter(key = FILTER_KEY.workshop): WorkshopFilter {
  const raw = LS.get<OldFilter | null>(key, null);
  if (!raw || typeof raw !== "object") return { ...DEFAULT_FILTER };
  const strs = (a: unknown) => (Array.isArray(a) ? a.filter((x): x is string => typeof x === "string" && x !== "") : []);
  const sort = typeof raw.sort === "string" && raw.sort ? raw.sort : DEFAULT_FILTER.sort;
  const trendDays = typeof raw.trendDays === "number" && raw.trendDays > 0 ? raw.trendDays : DEFAULT_FILTER.trendDays;
  const featureMatch = raw.featureMatch === "any" ? "any" : "all";
  const genreMatch = raw.genreMatch === "all" ? "all" : "any";
  if (Array.isArray(raw.include) || Array.isArray(raw.exclude)) {
    const include = [...new Set(strs(raw.include))];
    const exclude = [...new Set(strs(raw.exclude))].filter((t) => !include.includes(t)); // include XOR exclude
    return { sort, trendDays, include, exclude, featureMatch, genreMatch };
  }
  const include = [...new Set([raw.type, raw.ageRating, raw.resolution, ...strs(raw.genres), ...strs(raw.features)]
    .filter((x): x is string => typeof x === "string" && x !== ""))];
  const f: WorkshopFilter = { sort, trendDays, include, exclude: [], featureMatch, genreMatch };
  LS.set(key, f);
  return f;
}
export const filterOf = (s: State, scope: FilterScope) => scope === "library" ? s.libFilter : scope === "weLocal" ? s.weFilter : s.browseFilter;

// Applies a theme's 16 colors to :root as CSS vars (ThemeService color keys).
// COOL: --accent also drives every glow in the app.
// PERF: a library re-read (closing the item sidebar re-reads it, a sync, a WS reopen) keeps every item object whose content
// didn't change — and the whole array when nothing did — so the grid's memo'd cards and the playlist bar's items don't all
// re-render for a reload that changed nothing. Guard: probe-layout perf:sidebar (close).
function keepSame(prev: LibraryItem[], next: LibraryItem[]): LibraryItem[] {
  const old = new Map(prev.map((i) => [i.videoPath, i]));
  let same = prev.length === next.length;
  const out = next.map((n, k) => {
    const o = old.get(n.videoPath);
    const keep = o && JSON.stringify(o) === JSON.stringify(n) ? o : n;
    if (keep !== prev[k]) same = false;
    return keep;
  });
  return same ? prev : out;
}

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
  separateSceneTiming: true, switchScenesAfterSeconds: 1800, playlistStart: "start_over",
  transitionEnabled: false, transitionEffectIds: [], transitionDurationMs: 600, transitionDurationMaxMs: 0, transitionShuffle: true,
};

interface State {
  // browse
  sources: Source[]; activeSource: number; wallpapers: Wallpaper[]; page: number;
  loading: boolean; query: string; hasMore: boolean; downloads: Record<string, number>;
  // a Workshop download's step in words (WS download-progress `status`; e.g. "click Subscribe in Steam") — per page URL
  downloadStatus: Record<string, string>;
  browseFilter: WorkshopFilter; browseSort: number;
  // the local filters (FilterScope): the WE folder's on Browse, the Library's
  weFilter: WorkshopFilter; libFilter: WorkshopFilter;
  // what the shown list was read for (its source, search and filter; "" while a switched-to source loads): Browse starts
  // a list read for anything else at its top, and brings a kept scroll offset back only onto the list it was left on
  browseFor: string;
  // library
  libraryItems: LibraryItem[]; libQuery: string; libSort: number; undoDepth: number;
  // playlist
  playlist: string[]; playlistSettings: PlaylistSettings; playlistName: string | null; playlistNames: string[];
  // steam / workshop
  steam: { signedIn: boolean; rejected?: boolean; accountName: string; daysLeft: number | null; mode: string } | null;
  qrOpen: boolean; qrPng: string | null;
  // the password sign-in modal (SteamPasswordModal): which step Steam is at (WS steam-login-code), busy while a request /
  // Steam's answer is pending, the inline error. The password itself is never in the store — the modal's own field only.
  pwLogin: { step: "credentials" | "email" | "device" | "confirm"; hint: string | null; retry: boolean; busy: boolean; error: string | null } | null;
  unsub: { done: number; total: number; currentId: string; active: boolean } | null;
  // the Steam to-do (WS steam-todo; null / finished = idle) — components/SteamTodoPanel.tsx
  steamTodo: SteamTodo | null; setSteamTodo(t: SteamTodo | null): void;
  // the background scene-loudness queue's progress (WS scene-loudness-progress; null = idle)
  sceneLoudness: { done: number; total: number; currentId: string } | null;
  // the library's background operations running now (WS library-ops, GET /library/ops): the top bar's progress line
  libraryOps: LibraryOp[]; setLibraryOps(ops: LibraryOp[]): void;
  // the Browse sidebar's subscription toggle: a Subscribe's step per Workshop id (WS subscribe-progress; gone at its end), and
  // a counter bumped on every event that can change a subscription (the toggle re-reads /workshop/state on it)
  subProgress: Record<string, { value: number; status: string | null }>;
  wsStateTick: number; bumpWsState(): void;
  setSubProgress(id: string, p: { value: number; status: string | null } | null): void;
  subscribeWorkshop(id: string, title: string): Promise<void>;
  unsubscribeWorkshop(id: string, title: string): Promise<void>;
  // "Open on Steam": the item's page in the Steam app; its https page in the browser when that couldn't be opened
  openOnSteam(workshopId: string): Promise<void>;
  // shared
  themes: Theme[]; theme: Theme | null; settings: Record<string, unknown> | null; playingPath: string | null;
  // `liascape loop-current`: the rotation holds what plays (the player's prog:main.keep; /current.keep, WS loop-current)
  keepCurrent: boolean; setKeepCurrent: (k: boolean) => void;
  status: string; error: string | null;
  // the item sidebar (WE-style): the focused Library item's path / Browse
  // item's page URL, null = closed. In the store so the playlist bar (and Browse's "Show in Library") can focus an item and
  // a tab switch keeps it; the sidebars resolve the item from the live lists (a library-item-changed updates it in place).
  libFocus: string | null; browseFocus: string | null;
  // the sidebar picture's preview switch (GIF / Video / YouTube / the still): the last pick per sidebar, for the session — the
  // next item opens on it when it has one (components/SidePanel.tsx SideMedia)
  previewPref: { library: PreviewKind | null; browse: PreviewKind | null };
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
  // the active Browse source's filter column, if it has one: the Workshop's or the local WE folder's
  browseScope(): FilterScope | null;
  // the filter column (components/WorkshopFilterColumn.tsx), per scope: one tag's state (include / exclude / off), the
  // All / Any switches, all off; which groups are collapsed (remembered, shared)
  setTagState(tag: string, st: TagState, scope?: FilterScope): void; clearTags(scope?: FilterScope): void;
  setFilterIn(scope: FilterScope, p: Partial<WorkshopFilter>): void;
  // the filter panel, per page: docked, closed is remembered (filterColHidden / libFilterColHidden); as a drawer (a narrow
  // window) it starts closed (filterDrawer = the page whose drawer is open). The right-hand side holds one panel at a time:
  // opening the filters closes the page's item sidebar, focusing an item (focusLib / focusBrowse) closes its filters.
  filterColHidden: boolean; libFilterColHidden: boolean; filterDrawer: FilterPage | null;
  setFiltersOpen(page: FilterPage, open: boolean): void;
  filterCollapsed: string[]; toggleFilterGroup(id: string): void;
  download(source: number, w: Wallpaper, apply: boolean): Promise<void>;
  cancelDownload(id: string): void;
  setDownload(id: string, v: number, status?: string): void;
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
  openPwLogin(): void; startPwLogin(username: string, password: string): Promise<void>; submitPwCode(code: string): Promise<void>;
  cancelPwLogin(): Promise<void>; onPwCode(p: { kind: "email" | "device" | "confirm"; hint: string | null; retry: boolean }): void;
  onPwError(message: string): void;
  setUnsub(u: State["unsub"]): void;
  setSceneLoudness(p: State["sceneLoudness"]): void;
  openExternal(body: { path?: string; url?: string; reveal?: boolean; isScene?: boolean; workshopId?: string | null; copiedSceneDir?: string | null }): void;
  focusLib(path: string | null): void; focusBrowse(pageUrl: string | null): void;
  setPreviewPref(side: "library" | "browse", k: PreviewKind): void;
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
  loop: true, noAudio: true, disableCache: false, settingsLevel: "standard", videoFpsCap: 0, liveWallpaperBehindAllTabs: false,
  debugMode: false, debugOverlay: true, restartOnlyAtPlaylistChangeover: false, stayPausedWhenSwitching: false, replaceDirectWithWorkshop: false, volume: 100, speed: 1, restartMpvpaperEverySeconds: 600, normalizeAudio: false, normalizeTargetLufs: -14,
  globalSwitchWhenVideoEnds: true, globalIntervalSeconds: 0, globalMaxPlaySeconds: 0, autoAddLibraryToPlaylist: false,
  globalSeparateSceneTiming: true, globalSwitchScenesAfterSeconds: 1800,
  globalTransitionEnabled: false, globalTransitionEffectIds: [], globalTransitionDurationMs: 600, globalTransitionDurationMaxMs: 0, globalTransitionShuffle: true, transitionMethod: "reveal", fullLiveSyncOffsetMs: -30,
  autoMute: false, autoMuteOnlyIfMprisActive: false, autoMuteDelayMs: 500, autoUnmuteDelayMs: 2000, autoMuteMinLevelDb: -70,
  hwDec: "auto", videoScale: "fill", demuxerMaxMib: 20, demuxerMaxBackMib: 5, playerEngine: "legacy",
  autoThrottleScenes: true, limitVramPerScene: false, sceneVramLimitMib: 1536, vramLowMode: "stop",
  thumbnailAspect: "1:1", cardSize: "Medium", autoPlayGifs: false, autoPlayVideoThumbs: false, preferVideoThumbs: false, videoPreviewQuality: "mid", glows: true, morphs: true,
  copyFilesInsteadOfSymlinking: false, allowScenes: false, autoAddWeWallpapersToLibrary: false, sceneTransitionDelayMs: 1000, sceneMonitors: [],
  workshopDownloadMode: "subscribe", steamCmdPath: "", steamUsername: "",
  theme: "Catppuccin Mocha",
  // pause when covered, the playlist start, while parked
  pauseWhenCovered: "maximized", globalPlaylistStart: "start_over", rotateWhileParked: true,
};

// `wallpaper-changed` events seen so far (setPlaying). A Play's reply can come before or after the event of what it started.
let playingEvents = 0;
// After a Play / play-from: the UI never guesses what plays (under Shuffle it's the player's pick, not item 1; under Resume it
// may be what already plays). The player's `program.current` → `wallpaper-changed` says, when B starts; if none came yet, ask
// /current for the Play that switches nothing — unless the event lands meanwhile: it is newer than this answer can be.
async function markPlayingAfterPlay(get: () => State, set: (p: Partial<State>) => void, seen: number) {
  if (playingEvents === seen) {
    const cur = await api.current().catch(() => null);
    if (playingEvents === seen && cur?.path) set({ playingPath: cur.path });
  }
  get().refreshPlayingStatus(); // persistent now-playing line
}

let browseGen = 0; // the Browse list's generation (reload / loadMore)
// an item's sidebar opening on `page` closes that page's filter panel, if it shows (docked: remembered closed; a drawer: shut)
function closeFiltersFor(page: FilterPage) {
  const s = useStore.getState();
  if (s.filterDrawer === page) useStore.setState({ filterDrawer: null });
  if ((page === "library" ? s.libFilterColHidden : s.filterColHidden) || !matchMedia(WF_DOCK_QUERY).matches) return;
  s.setFiltersOpen(page, false);
}
export const useStore = create<State>((set, get) => ({
  sources: [], activeSource: 0, wallpapers: [], page: 1, loading: false, query: "", hasMore: true, downloads: {}, downloadStatus: {},
  browseFor: "", browseFilter: loadBrowseFilter(), browseSort: LS.get("browseSort", 0),
  weFilter: loadBrowseFilter(FILTER_KEY.weLocal), libFilter: loadBrowseFilter(FILTER_KEY.library),
  filterCollapsed: LS.get<string[]>("browseFilterCollapsed", ["features"]),
  // the docked filter panel closed; remembered
  filterColHidden: LS.get<boolean>("browseFilterHidden", false), libFilterColHidden: LS.get<boolean>("libFilterHidden", false), filterDrawer: null,
  libraryItems: [], libQuery: "", libSort: LS.get("libSort", 5), undoDepth: 0,
  playlist: [], playlistSettings: DEFAULT_PS, playlistName: null, playlistNames: [],
  steam: null, qrOpen: false, qrPng: null, pwLogin: null, unsub: null, steamTodo: null, sceneLoudness: null, libraryOps: [],
  subProgress: {}, wsStateTick: 0,
  themes: [], theme: null, settings: null, playingPath: null, keepCurrent: false, status: "", error: null,
  libFocus: null, browseFocus: null, previewPref: { library: null, browse: null }, appActive: true,

  // The backend may be unreachable right now: restarting (`dotnet watch` on a source change — whose HMR update re-runs
  // this init into that very gap — or a relaunch). Retry until it answers; a read that failed never becomes what the
  // page shows (a failed /library taken as [] would say "Library is empty" for good while a wallpaper plays).
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
  // PERF: another source drops the old list at once (its placeholder grid shows meanwhile): the old cards unmount and abort
  // their thumbnails' loads (components/Card.tsx). Kept up, a slow source's /img proxy loads hold every one of the
  // browser's 6 connections to the backend, and the new source's /browse queues behind them for seconds — the old list
  // under the new pill all that time. Guard: matrix browse:switchSource.
  setSource(i) {
    set(i === get().activeSource ? { browseFocus: null } : { activeSource: i, browseFocus: null, wallpapers: [], hasMore: true, browseFor: "" });
    if (!get().browseScope() && get().filterDrawer === "browse") set({ filterDrawer: null }); // a source without filters
    LS.set("activeSource", i); get().reload();
  },
  setQuery(q) { set({ query: q }); clearTimeout(searchTimer); searchTimer = setTimeout(() => get().reload(), 200); },
  isWorkshop() { return !!get().sources[get().activeSource]?.supportsTagFilter; },
  browseScope() { const src = get().sources[get().activeSource]; return src?.supportsTagFilter ? "workshop" : src?.supportsLocalFilter ? "weLocal" : null; },
  // update the filter instantly (UI is snappy) but DEBOUNCE the network reload — rapid chip toggles
  // would otherwise fire a full refetch + grid re-render each → laggy.
  setBrowseFilter(p) { const bf = { ...get().browseFilter, ...p }; set({ browseFilter: bf }); LS.set("browseFilter", bf); clearTimeout(filterTimer); filterTimer = setTimeout(() => get().reload(), 280); },
  setBrowseSort(i) { set({ browseSort: i }); LS.set("browseSort", i); }, // client-side (WE-local; single page)
  // a tag is in include XOR exclude; the same debounced reload as every filter change
  setTagState(tag, st, scope = "workshop") {
    const { include, exclude } = filterOf(get(), scope);
    const inc = include.filter((t) => t !== tag), exc = exclude.filter((t) => t !== tag);
    if (st === "inc") inc.push(tag); else if (st === "exc") exc.push(tag);
    // "In my library" filters the list already loaded (Browse's render) — no reload for it
    if (scope === "workshop" && tag.startsWith("@")) { const bf = { ...get().browseFilter, include: inc, exclude: exc }; set({ browseFilter: bf }); LS.set("browseFilter", bf); return; }
    get().setFilterIn(scope, { include: inc, exclude: exc });
  },
  // the Workshop's filter reloads (debounced); a local one is the list's own render — no request, nothing to wait for
  setFilterIn(scope, p) {
    if (scope === "workshop") { get().setBrowseFilter(p); return; }
    const f = { ...filterOf(get(), scope), ...p };
    set(scope === "library" ? { libFilter: f } : { weFilter: f }); LS.set(FILTER_KEY[scope], f);
  },
  clearTags(scope = "workshop") { const f = filterOf(get(), scope); if (f.include.length || f.exclude.length) get().setFilterIn(scope, { include: [], exclude: [] }); },
  // Guard: probe-filters swap:browse, swap:library, panel:persist
  setFiltersOpen(page, open) {
    if (!matchMedia(WF_DOCK_QUERY).matches) {
      const d = get().filterDrawer;
      if (open || d === page) set({ filterDrawer: open ? page : null });
    } else if (page === "library") { set({ libFilterColHidden: !open }); LS.set("libFilterHidden", !open); }
    else { set({ filterColHidden: !open }); LS.set("browseFilterHidden", !open); }
    if (open) { if (page === "library") get().focusLib(null); else get().focusBrowse(null); }
  },
  toggleFilterGroup(id) {
    const c = get().filterCollapsed, n = c.includes(id) ? c.filter((x) => x !== id) : [...c, id];
    set({ filterCollapsed: n }); LS.set("browseFilterCollapsed", n);
  },
  // API: every Browse list read carries the generation it started in (`browseGen`): a source switch / search / refresh
  // starts a new one, and a reply from an older one is dropped — else a slow online source's page lands AFTER the
  // source the user switched to and replaces (or extends) its list, under the new source's pill (seen in the
  // morph probe: MotionBgs' list shown under "Wallpaper Engine (Local)")
  async reload() {
    const { activeSource, query } = get();
    const filter = get().isWorkshop() ? wireFilter(get().browseFilter) : undefined;
    const gen = ++browseGen;
    set({ loading: true, page: 1 });
    try {
      const list = await api.browse(activeSource, 1, query || undefined, filter);
      if (gen !== browseGen) return;
      set({ wallpapers: list, browseFor: JSON.stringify([activeSource, query, filter ?? null]),
        hasMore: !!get().sources[activeSource]?.supportsPagination && list.length > 0 });
    } catch (e) {
      // e.g. Steam's cooldown (SteamGate): "Steam is limiting requests from this connection — try again in N min"
      if (gen === browseGen) {
        get().setStatus(e instanceof Error ? e.message : String(e), true);
        if (!get().wallpapers.length) set({ hasMore: false }); // a switched-to source that failed: no placeholders asking for page 2
      }
    } finally { if (gen === browseGen) set({ loading: false }); }
  },
  async loadMore() {
    const { activeSource, query, page, loading, hasMore, wallpapers } = get();
    if (loading || !hasMore) return;
    const filter = get().isWorkshop() ? wireFilter(get().browseFilter) : undefined;
    const gen = browseGen;
    set({ loading: true });
    try {
      const next = page + 1;
      const list = await api.browse(activeSource, next, query || undefined, filter);
      if (gen !== browseGen) return; // a reload started meanwhile: this page belongs to the old list
      // Dedup by pageUrl — "Most Popular" et al. shift between requests, so pages overlap
      // pages overlap; appending dupes = duplicate React keys → reorder/jump. Keep existing order, add
      // only fresh items at the bottom, and stop when a page yields nothing new.
      const existing = new Set(wallpapers.map((w) => w.pageUrl));
      const fresh = list.filter((w) => !existing.has(w.pageUrl));
      if (fresh.length === 0) { set({ page: next, hasMore: false }); return; }
      set({ wallpapers: [...wallpapers, ...fresh], page: next, hasMore: list.length > 0 });
    } catch (e) {
      if (gen === browseGen) get().setStatus(e instanceof Error ? e.message : String(e), true); // e.g. Steam's cooldown
    } finally { if (gen === browseGen) set({ loading: false }); }
  },
  async download(source, w, apply) {
    const ctrl = new AbortController(); dlCtrls[w.pageUrl] = ctrl;
    set({ downloads: { ...get().downloads, [w.pageUrl]: 0 } });
    try {
      const item = await api.download(source, w, apply, ctrl.signal);
      if ("skipped" in item && item.skipped) { get().setStatus(`Skipped: ${w.title}`); return; } // the Steam to-do's Skip / Stop
      if ("error" in item && item.error) { get().setError(`Download failed: ${item.error}`); return; }
      await get().loadLibrary();
      get().setStatus(apply ? `Applied: ${w.title}` : `Downloaded: ${w.title}`);
    } catch (e) {
      if (ctrl.signal.aborted) get().setStatus(`Cancelled: ${w.title}`);
      else get().setError(`Download failed: ${(e as Error).message}`); // error modal
    } finally {
      delete dlCtrls[w.pageUrl];
      const d = { ...get().downloads }; delete d[w.pageUrl];
      const st = { ...get().downloadStatus }; delete st[w.pageUrl];
      set({ downloads: d, downloadStatus: st });
    }
  },
  cancelDownload(id) { dlCtrls[id]?.abort(); }, // cancel an in-flight download
  setDownload(id, v, status) {
    if (!(id in get().downloads)) return; // a late event for a download that already ended (finished / cancelled)
    if (status === undefined) { set({ downloads: { ...get().downloads, [id]: v } }); return; }
    const changed = get().downloadStatus[id] !== status;
    set({ downloads: { ...get().downloads, [id]: v }, downloadStatus: { ...get().downloadStatus, [id]: status } });
    // the status bar says it too — a download started from a card has no sidebar showing it; untimed while it waits on
    // the user (Steam's Subscribe button): the next status / the download's end replaces it
    if (changed) get().setStatus(status, false);
  },
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
  async loadLibrary() {
    const items = await api.library(), depth = (await api.undoDepth()).depth;
    set({ libraryItems: keepSame(get().libraryItems, items), undoDepth: depth });
  },
  // optimistic per-item patch (volume/speed override etc.) so consumers — incl. the live WallpaperBg —
  // reflect a change instantly without waiting for a full library reload.
  patchLibraryItem(path, partial) { set((s) => ({ libraryItems: s.libraryItems.map((i) => i.videoPath === path ? { ...i, ...partial } : i) })); },
  // API: `library-item-changed` — the backend changed an item itself (a volume keybind on a wallpaper with its
  // own volume, `VolumeKeyTarget`): the grid's copy — the sidebar reads it from there (else it would show — and its next
  // slider save restore — the old value)
  itemChangedByBackend(path, partial) {
    const p = (i: LibraryItem) => (i.videoPath === path ? { ...i, ...partial } : i);
    set((s) => ({ libraryItems: s.libraryItems.map(p) }));
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
    const seen = playingEvents;
    const r = await api.playPlaylist(playlist, playlistSettings);
    if (r.message) { get().setStatus(r.message); return; }   // error/interval messages
    set({ keepCurrent: false }); // a Play starts the rotation: loop-current's keep ends (LiascapePlayerProgram.LoadNow)
    await markPlayingAfterPlay(get, set, seen);
  },
  async playFrom(index) {
    const { playlist, playlistSettings } = get();
    const seen = playingEvents;
    const r = await api.playFrom(playlist, index, playlistSettings);
    if (r.message) { get().setStatus(r.message); return; }
    set({ keepCurrent: false });
    await markPlayingAfterPlay(get, set, seen);
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
  onSignedIn(s) { set({ steam: s, qrOpen: false, qrPng: null, pwLogin: null }); get().setStatus("Signed in to Steam"); },
  openPwLogin() { set({ pwLogin: { step: "credentials", hint: null, retry: false, busy: false, error: null } }); },
  async startPwLogin(username, password) {
    set({ pwLogin: { step: "credentials", hint: null, retry: false, busy: true, error: null } });
    try { await api.steamLogin(username, password); } // Steam's next step / the result come over WS
    catch (e) { const p = get().pwLogin; if (p) set({ pwLogin: { ...p, busy: false, error: (e as Error).message } }); }
  },
  async submitPwCode(code) {
    const p0 = get().pwLogin; if (!p0) return;
    set({ pwLogin: { ...p0, busy: true, error: null, retry: false } });
    try { await api.steamLoginCode(code); }
    catch (e) { const p = get().pwLogin; if (p) set({ pwLogin: { ...p, busy: false, error: (e as Error).message } }); }
  },
  async cancelPwLogin() {
    const p = get().pwLogin;
    set({ pwLogin: null });
    if (p && (p.busy || p.step !== "credentials")) await api.steamLoginCancel().catch(() => {});
  },
  // the step Steam asks for (a "wrong code" retry of the same step says so)
  onPwCode(c) { if (get().pwLogin) set({ pwLogin: { step: c.kind, hint: c.hint, retry: c.retry, busy: false, error: null } }); },
  // back to the first step with the error (its password field starts empty: the password is never kept)
  onPwError(message) { if (get().pwLogin) set({ pwLogin: { step: "credentials", hint: null, retry: false, busy: false, error: message } }); },
  setUnsub(u) { set({ unsub: u }); },
  setSteamTodo(t) { set({ steamTodo: t && "finished" in t && t.finished ? null : t }); },
  setSceneLoudness(p) { set({ sceneLoudness: p }); },
  setLibraryOps(ops) { set({ libraryOps: ops }); },

  openExternal(body) { api.open(body).catch(() => {}); },
  async openOnSteam(workshopId) {
    let ok = false;
    try { ok = (await api.openSteamPage(workshopId)).ok; } catch { /* the backend refused / is away: the browser below */ }
    // the Steam app couldn't be opened: the page in the user's browser (main.js' window-open handler → shell.openExternal)
    if (!ok) window.open(steamPageUrl(workshopId), "_blank", "noreferrer");
  },

  bumpWsState() { set({ wsStateTick: get().wsStateTick + 1 }); },
  setSubProgress(id, p) {
    const next = { ...get().subProgress };
    if (p) next[id] = p; else delete next[id];
    set({ subProgress: next });
  },
  async subscribeWorkshop(id, title) {
    get().setSubProgress(id, { value: 0, status: "Subscribing…" });
    try {
      const r = await api.workshopSubscribe(id, title);
      // the page route: the to-do panel has the step; the status bar says what to click
      get().setStatus(r.inSteamTodo ? `${title}: click Subscribe in Steam, then Next` : `Subscribed: ${title}`, !r.inSteamTodo);
      if (r.subscribed) get().setSubProgress(id, null);
    } catch (e) {
      get().setSubProgress(id, null);
      get().setStatus(`Subscribing failed: ${(e as Error).message}`);
    }
    get().bumpWsState();
  },
  async unsubscribeWorkshop(id, title) {
    try {
      const r = await api.workshopUnsubscribe(id, title);
      // an item in the library went to the trash like Delete from source — the library + the status bar's Undo follow
      if (r.inLibrary) await get().loadLibrary();
      get().setStatus(r.inLibrary ? `Unsubscribing ${title} — removed from your library` : `Unsubscribing ${title}`);
    } catch (e) { get().setStatus(`Unsubscribing failed: ${(e as Error).message}`); }
    get().bumpWsState();
  },

  // closing re-reads the library (the modal did too: what its edits saved, whatever the optimistic patches missed)
  focusLib(path) {
    const was = get().libFocus; set({ libFocus: path });
    if (path) closeFiltersFor("library");
    if (was && !path) get().loadLibrary().catch(() => {});
  },
  focusBrowse(pageUrl) { set({ browseFocus: pageUrl }); if (pageUrl && get().browseScope()) closeFiltersFor("browse"); },
  setPreviewPref(side, k) { set((s) => ({ previewPref: { ...s.previewPref, [side]: k } })); },

  // ---- shared ----
  applyTheme(name) {
    const theme = get().themes.find((t) => t.name === name);
    if (!theme) return;
    applyThemeVars(theme); set({ theme });
    const s = { ...(get().settings ?? {}), theme: name };
    set({ settings: s }); api.saveSettings(s).catch(() => {});
  },
  setKeepCurrent(k) { set({ keepCurrent: k }); get().refreshPlayingStatus(); },
  setPlaying(p) { playingEvents++; set({ playingPath: p }); get().refreshPlayingStatus(); },
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
    if (st.keepCurrent) desc += ", looping this one (loop-current)";
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
  const [sources, themes, settings, cur, lib, pstate, names, depth, steam, todo, ops] = await Promise.all([
    r(api.sources()), r(api.themes()), r(api.settings()), r(api.current()), r(api.library()), r(api.playlistState()),
    r(api.playlistNames(), false), r(api.undoDepth(), false), r(api.steamStatus(), false), r(api.steamTodo(), false),
    r(api.libraryOps(), false),
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
  if (cur) { p.playingPath = cur.v?.path ?? null; p.keepCurrent = !!cur.v?.keep; }
  if (lib) p.libraryItems = keepSame(st.libraryItems, lib.v);
  if (pstate && !playlistBarSavePending) {
    p.playlist = pstate.v?.videoPaths ?? []; p.playlistSettings = pstate.v?.settings ?? DEFAULT_PS; p.playlistName = pstate.v?.name ?? null;
  }
  if (names) p.playlistNames = names.v;
  if (depth) p.undoDepth = depth.v.depth;
  if (steam) p.steam = steam.v;
  if (todo) p.steamTodo = "finished" in todo.v && todo.v.finished ? null : todo.v;
  if (ops) p.libraryOps = ops.v;
  set(p);
  if (playingLine) get().refreshPlayingStatus(); // the now-playing line follows (a transient notice reverts to it itself)
  return !unreachable;
}
