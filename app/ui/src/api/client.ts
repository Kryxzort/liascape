// API: typed client for the C# serve backend. The Electron shell launches the window with
// ?api=<port> (read from ~/.config/liascape/serve.port); browser dev: append ?api=PORT.
const params = new URLSearchParams(location.search);
const port = params.get("api") || localStorage.getItem("liascape_api_port") || "";
if (port) localStorage.setItem("liascape_api_port", port);
export const API = port ? `http://127.0.0.1:${port}` : "";
// API: media (/img /media /clip /anim /still) comes from the backend's media listener, the API's port + 1: another origin, so
// slow thumbnail and video loads fill the browser's 6 connections to IT and never queue an API call behind them
// (.claude/rules/backend/api.md § Security; docs/decisions.md § "Serve media from a second listener"). A page whose API
// port is unknown keeps media on the API's own origin, which still serves them. Guard: matrix browse:mediaPool.
const apiPort = Number(port || location.port);
export const MEDIA = Number.isInteger(apiPort) && apiPort > 0 && apiPort < 65535 ? `http://127.0.0.1:${apiPort + 1}` : API;

// API: the backend's token (.claude/rules/backend/api.md § Security — every request but the static UI and /health needs it).
// The shell (app/shell/main.js) opens the window with ?token=<~/.config/liascape/serve.token>; browser dev: append
// &token=… yourself. Kept in sessionStorage (a reload keeps it) and taken out of the address bar at once.
const TOKEN_KEY = "liascape_token";
const urlToken = params.get("token");
if (urlToken) {
  try { sessionStorage.setItem(TOKEN_KEY, urlToken); } catch { /* storage off: this page load still has it */ }
  params.delete("token");
  const q = params.toString();
  try { history.replaceState(history.state, "", `${location.pathname}${q ? `?${q}` : ""}${location.hash}`); } catch { /* file:// edge cases */ }
}
const TOKEN = urlToken || (() => { try { return sessionStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; } })();
// fetch(): the header. An <img>/<video> src or the WebSocket can't send one → ?token= (GET only, the backend's rule)
export const authHeaders = (h: Record<string, string> = {}): Record<string, string> => (TOKEN ? { ...h, "X-Liascape-Token": TOKEN } : h);
export const withToken = (url: string) => (TOKEN ? `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(TOKEN)}` : url);

// route remote thumbs/gifs through the proxy (UA + Referer + CORS); local files via /media
export const img = (u: string, referer?: string) =>
  withToken(`${MEDIA}/img?u=${encodeURIComponent(u)}${referer ? `&r=${encodeURIComponent(referer)}` : ""}`);
export const media = (path: string) => withToken(`${MEDIA}/media?path=${encodeURIComponent(path)}`);
// API: the preview clips of a local video (/clip, the backend's Web/ClipStore.cs): what "Animate wallpapers without a GIF" plays
// (components/clipSource.ts). clipInfo names the clip to play now for a box of w × h device pixels at a quality (`v`, an
// immutable file), the quality it was made at (`q`) and whether a better one is being made (`pending`: ask again); clipFile is
// that clip's bytes.
export type ClipQuality = "low" | "mid" | "high";
export type ClipInfo = { v: string | null; full: boolean; pending: boolean; q?: ClipQuality | null };
// `exact`: a clip of exactly that quality, a short sample when the stored clip is another (Settings' card preview)
export async function clipInfo(path: string, w: number, h: number, q: ClipQuality, exact = false): Promise<ClipInfo> {
  const r = await fetch(withToken(`${MEDIA}/clip?path=${encodeURIComponent(path)}&w=${w}&h=${h}&q=${q}&info=1${exact ? "&exact=1" : ""}`));
  if (!r.ok) throw new Error(`/clip → ${r.status}`);
  return r.json();
}
// API: each quality's fps cap and its disk cost per wallpaper (MB: the store's median full clip, else a typical one) — the
// backend's own table (/clip/qualities), for Settings' card preview caption
export type ClipQualityInfo = { name: ClipQuality; fps: number; mb: number; measured: boolean };
// one cache Settings → Housekeeping can clear (AppOps.CacheCategories): what a clear would free now, and after one what it freed
export type CacheSize = { id: string; bytes: number; count: number };
export type CacheCleared = CacheSize & { freedBytes: number };
export const clipQualities = () => jget<{ qualities: ClipQualityInfo[] }>("/clip/qualities").then((r) => r.qualities);
export const clipFile = (path: string, v: string) => withToken(`${MEDIA}/clip?path=${encodeURIComponent(path)}&v=${encodeURIComponent(v)}`);
// API: the app went inactive with these clip boxes last seen off screen (the backend shrinks a clip 2x wider than needed),
// or came back (idle false)
export const clipShrink = (idle: boolean, items: { path: string; w: number; h: number; q: ClipQuality }[]) =>
  fetch(`${API}/clip/shrink`, { method: "POST", headers: authHeaders({ "Content-Type": "application/json", "X-Liascape-Client": CLIENT_ID }),
    body: JSON.stringify({ idle, items }) }).catch(() => undefined);
// API: POST /clip/sweep-hold — a held quality change waits (ClipStore.HoldSweep); the hold is a lease the caller renews
export const clipSweepHold = (hold: boolean) =>
  fetch(`${API}/clip/sweep-hold`, { method: "POST", headers: authHeaders({ "Content-Type": "application/json", "X-Liascape-Client": CLIENT_ID }),
    body: JSON.stringify({ hold }) }).catch(() => undefined);
// animated preview: serve remote gifs from a disk cache (/anim, range/length → loops cleanly, like
// local /media) instead of the live /img proxy which flashes black at the gif loop seam.
// gif (remote OR local) → /anim, which trims the leading fade-from-black + serves seekable so it loops
// without a black seam. Other local formats (animated webp) loop fine raw → /media.
export const anim = (u: string) =>
  /^https?:/i.test(u) || /\.gif$/i.test(u) ? withToken(`${MEDIA}/anim?u=${encodeURIComponent(u)}`) : media(u);
// static thumbnail for an animated preview: a non-black/white extracted frame (so AutoPlayGifs-off
// doesn't show the gif's black frame-0, AND so a gif used as a static thumbnail doesn't self-animate).
// Remote URLs and local gif/webp → /still (ffmpeg extract); plain local images → /media as-is.
// w = decode-to-size width. A SIZED request (card layer) always routes through /still so even big
// plain jpgs (WE previews are ~1024–1388px) decode down to the card's px → far less texture memory.
// A NATIVE request (enlarged modal, no w) only needs /still for gif/webp/remote (frame extraction);
// plain local images pass straight to /media uncropped + un-re-encoded (crisp, no quality loss).
export const still = (u: string, w?: number) => {
  if (w) return withToken(`${MEDIA}/still?u=${encodeURIComponent(u)}&w=${w}`);
  return /^https?:/i.test(u) || /\.(gif|webp)$/i.test(u) ? withToken(`${MEDIA}/still?u=${encodeURIComponent(u)}`) : media(u);
};
// card thumbnails decode to this width (never upscales — min(w,iw) caps at the source). Generous
// enough for Large cards at hidpi; previews are usually ≤640px so most are served at native size.
export const CARD_STILL_W = 640;
// pick the right transport by URL shape: WE-local sources hand us absolute file paths (→ /media),
// everything else is a remote URL (→ /img proxy). Avoids blank WE-local thumbnails.
export const thumb = (u: string, referer?: string) =>
  /^https?:/i.test(u) ? img(u, referer) : media(u);

// API: this page's id on every POST (X-Liascape-Client) — a state broadcast names the client that made the change, so a
// page ignores the echo of its own save (a resync over a pending playlistBar edit) and follows everyone else's
export const CLIENT_ID = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);

async function jget<T>(path: string): Promise<T> {
  const r = await fetch(`${API}${path}`, { headers: authHeaders() });
  if (!r.ok) throw await apiError(path, r);
  return r.json();
}
// API: a refused request's {error} words, its status, and `signIn` — the action needs the Steam sign-in (the UI's "Sign in to …")
export class ApiError extends Error {
  readonly status: number; readonly signIn: boolean;
  constructor(message: string, status: number, signIn = false) { super(message); this.status = status; this.signIn = signIn; }
}
async function apiError(path: string, r: Response): Promise<ApiError> {
  let body: { error?: string; signIn?: boolean } | null = null;
  if (r.headers.get("content-type")?.includes("json")) { try { body = await r.json(); } catch { /* not JSON after all */ } }
  return new ApiError(body?.error ?? `${path} → ${r.status}`, r.status, body?.signIn === true);
}
// WS steam-todo / GET /steam-todo (Web/SteamTodo.cs): the current entry + the count, or `finished` (idle). `delivered` = Steam
// already has the current one (its download finished) — still the user's Next; `message` = the Steam app couldn't be opened /
// reached; `busy` = "Let the Steam app do all N" is asking Steam.
// POST /workshop/state: a Workshop item's subscription as the Browse sidebar shows it (disk + the unsubscribe queue + the to-do)
export type WorkshopSubState = { subscribed: boolean; pending: "subscribe" | "unsubscribe" | null; inLibrary: boolean; onDisk: boolean };
export const steamPageUrl = (workshopId: string) => `https://steamcommunity.com/sharedfiles/filedetails/?id=${workshopId}`;
export type SteamTodo =
  | { finished: true }
  | { finished?: false; action: "subscribe" | "unsubscribe"; index: number; total: number; remaining: number;
      current: { id: string; title: string }; delivered?: boolean; message?: string | null; busy?: boolean;
      // the current subscribe entry moves on by itself once Steam's files for it appear (they weren't there when its page opened)
      autoNext?: boolean };

async function jpost<T = void>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const r = await fetch(`${API}${path}`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json", "X-Liascape-Client": CLIENT_ID }),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  // an error the backend explains ({error}: e.g. Steam's cooldown — "try again in N min") is shown as its own words
  if (!r.ok) throw await apiError(path, r);
  return (r.headers.get("content-type")?.includes("json") ? r.json() : undefined) as Promise<T>;
}

// ---- types (mirror the C# camelCase DTOs) ----
export interface FeatureHealth { id: string; label: string; ok: boolean | null; reason: string | null; affects: string[]; inUse?: boolean }

// API: POST /browse `filter` (Workshop only). `include` / `exclude` are Steam tag names (age rating, type, resolution, genre,
// feature — one flat set each; a tag is in at most one of them). The backend owns the semantics: within a group any included
// tag matches (Genre / Features: per genreMatch / featureMatch), across groups all must; an excluded tag hides; any age filter hides items
// without an age rating (WorkshopFilterColumn.tsx).
export interface WorkshopFilter {
  sort: string; trendDays: number; include: string[]; exclude: string[];
  // the included features: every one must match ("all", the default) or any of them ("any"); the same for genres, whose
  // default is "any" (docs/decisions.md § "AND Workshop features, OR genres, each switchable") — only these two groups have the choice
  featureMatch: "all" | "any"; genreMatch: "all" | "any";
}
// API: POST /browse `list` (Models/WorkshopList.cs): which Workshop items Browse shows — the whole Workshop (null), the signed-in
// account's favourites, or one creator's items (`name` / `avatar` only for the pill). A list sorts by "lastupdated" or
// "toprated" only and has no search (Steam's client protocol can't search a user's files).
export type WsList = { kind: "favorites" } | { kind: "creator"; id: string; name: string | null; avatar: string | null } | null;
export type WsListSort = "lastupdated" | "toprated";
// API: the Browse sidebar's Workshop community pieces (Web/WorkshopSocialOps.cs). A comment's text is plain text — the backend
// takes it out of Steam's HTML — and is only ever rendered as text.
export type WsCreator = { steamId: string; name: string | null; avatar: string | null };
export type WsComment = { id: string; author: string; authorId: string | null; avatar: string | null; time: number; text: string };
export type WsComments = { signedIn: boolean; owner: string; total: number; start: number; comments: WsComment[] };
export interface Source {
  index: number; name: string; supportsSearch: boolean; supportsPagination: boolean;
  supportsSorting: boolean; supportsTagFilter: boolean; pageSizeHint: number; available: boolean;
  // API: the UI filters this source's list itself from its items' tags / age rating (the local Wallpaper Engine folder)
  supportsLocalFilter?: boolean;
}
export interface Wallpaper {
  title: string; thumbnailUrl: string; animatedThumbnailUrl: string | null; pageUrl: string;
  resolution: string | null; isScene: boolean; workshopId: string | null; addedAt: string | null;
  description: string | null; authorName: string | null; fileSizeBytes: number | null;
  // a Workshop result's creator (a Steam ID): its sidebar's creator row and comment thread
  authorId?: string | null;
  subscriptions: number | null; favorites: number | null; tags: string[] | null;
  // Workshop results: the item's YouTube trailer when known, and whether the backend looked it up (none ≠ not checked)
  youtubeUrl?: string | null; trailerKnown?: boolean;
  // the local Wallpaper Engine folder's items: project.json's age rating (a Workshop result's is in its tags)
  ageRating?: string | null;
}
export interface Detail {
  title: string; previewUrl: string; downloadUrl: string; needsReferrer: boolean;
  referrer: string | null; isScene: boolean; workshopId: string | null; isWorkshopAcquire: boolean;
  resolution: string | null; ageRating: string | null; youtubeUrl: string | null; pageUrl: string | null;
  authorName: string | null; description: string | null; fileSizeBytes: number | null;
  subscriptions: number | null; favorites: number | null; tags: string[] | null;
}
export interface LibraryItem {
  title: string; videoPath: string; thumbnailPath: string | null; animatedThumbnailPath: string | null;
  sourceId: string | null;
  isScene: boolean; workshopId: string | null; copiedSceneDir: string | null;
  hasCrashed: boolean; isWhitelisted: boolean; volumeOverride: number | null;
  speedOverride: number | null; addedAt: string;
  resolution: string | null; ageRating: string | null; youtubeUrl: string | null; pageUrl: string | null;
  authorName: string | null; description: string | null; fileSizeBytes: number | null;
  subscriptions: number | null; favorites: number | null; tags: string[] | null;
  // a scene's loudness under liascape-player (its current audio configuration): the applied LUFS, estimated (the
  // offline estimate — not played in this configuration yet) or measured (loudnessSeconds of audible play), the
  // estimate's confidence and, when low, its first note. null for a video / nothing known.
  loudnessLufs?: number | null; loudnessEstimated?: boolean | null; loudnessSeconds?: number | null;
  loudnessConfidence?: string | null; loudnessNote?: string | null;
}
// a long background operation of the library (Web/LibraryOps.cs): `clips` = the preview clips' queue: following "Video
// preview quality" (phase low | mid | high) or the cards' own first clips (make), `facts` = Steam's tags (steam), trailer
// pages (trailers), frame sizes (sizes)
export interface LibraryOp { id: string; phase: string; done: number; total: number }
export interface SceneLoudnessStatus { running: boolean; done: number; total: number; current: string | null; failed: { path: string; error: string }[] }
export interface PlaylistSettings {
  order: 0 | 1; overrideGlobalSettings: boolean; intervalSeconds: number;
  // the rotation: switchWhenVideoEnds off → intervalSeconds is a timer; on → it is the minimum play time and
  // maxPlaySeconds the maximum, and separateSceneTiming gives scenes + still images their own
  // switchScenesAfterSeconds (wall-clock seconds, 0 = off everywhere) — player-adapter.md § Rotation
  switchWhenVideoEnds: boolean; maxPlaySeconds: number; separateSceneTiming: boolean; switchScenesAfterSeconds: number;
  // "When the playlist starts again" (gated by overrideGlobalSettings; else the globalPlaylistStart setting) — plan § Playlist start
  playlistStart: "start_over" | "resume";
  // WE-style transitions (gated by overrideGlobalSettings; else the globalTransition* fallbacks).
  transitionEnabled: boolean; transitionEffectIds: string[];
  transitionDurationMs: number; transitionDurationMaxMs: number; transitionShuffle: boolean;
}
export interface TransitionUniform { name: string; type: string; default: number[] | null }
export interface TransitionEffect {
  id: string; name: string; category: string; defaultOn: boolean;
  author: string; license: string; uniforms: TransitionUniform[] | null;
  reveal?: boolean; // plays live (B keeps playing) in Reveal method; else frozen fallback there
}
// a scene's user property (SceneProperties.Describe): value/default in WE's encoding — bool, number,
// colour "r g b" (0–1), combo key, text
export interface SceneProp {
  name: string; type: string; label: string; order: number; condition: string | null; visible: boolean;
  editable: boolean; unsupported: string | null; default: unknown; value: unknown; overridden: boolean;
  min: number | null; max: number | null; step: number | null; fraction: boolean; precision: number | null;
  options: { label: string; value: string }[] | null;
}
export interface ScenePropsResp { path: string; engine: string; live: boolean; note: string | null; props: SceneProp[] }
export interface CustomPlaylist { videoPaths: string[]; settings: PlaylistSettings; name: string | null; }
export interface Theme {
  name: string; bgBase: string; bgMantle: string; bgCrust: string;
  surface0: string; surface1: string; surface2: string; textColor: string; subtext: string;
  muted: string; accent: string; accentFg: string; accentHover: string;
  danger: string; dangerBg: string; success: string;
}

export const api = {
  sources: () => jget<Source[]>("/sources"),
  browse: (source: number, page: number, query?: string, filter?: WorkshopFilter, list?: { kind: string; id?: string; sort: WsListSort }) =>
    jpost<Wallpaper[]>("/browse", { source, page, query, filter, list }),
  detail: (source: number, result: Wallpaper) => jpost<Detail>("/detail", { source, result }),
  settings: () => jget<Record<string, unknown>>("/settings"),
  monitors: () => jget<{ name: string; refreshHz: number; primary: boolean }[]>("/monitors"),
  saveSettings: (s: Record<string, unknown>) => jpost("/settings", s),
  mpvPreview: () => fetch(`${API}/mpv-preview`, { headers: authHeaders() }).then((r) => r.text()),
  // Player engine row: asked-for vs running engine, whether liascape-player can run (+ why not)
  playerEngine: () => jget<{ engine: string; active: string; available: boolean; binary: string | null; reason: string | null;
    scenes?: { available: boolean; reason: string | null; assets_dir: string | null };
    vram?: { low_active: boolean | null; mode: string } | null }>("/player-engine"),
  // API: /health/features — features a missing build piece / tool breaks here (FeatureHealth.cs); `affects` = the
  // settings keys whose rows get a warning icon. ok null = not known yet.
  featureHealth: () => jget<{ features: FeatureHealth[] }>("/health/features"),
  lwePreview: () => fetch(`${API}/lwe-preview`, { headers: authHeaders() }).then((r) => r.text()),
  importFile: (path: string, title: string) => jpost<LibraryItem>("/library/import", { path, title }),
  libraryClear: () => jpost("/library/clear"),
  // API: the caches Settings → Housekeeping clears (ServerHost /cache/size, /cache/clear; ids and folders: AppOps.CacheCategories).
  // A clear names its ids (an unknown one → 400); each answer says what it freed and what the cache still holds.
  cacheSize: () => jget<{ categories: CacheSize[] }>("/cache/size"),
  clearCache: (ids: string[]) => jpost<{ categories: CacheCleared[]; freedBytes: number; count: number }>("/cache/clear", { ids }),
  themes: () => jget<Theme[]>("/themes"),
  library: () => jget<LibraryItem[]>("/library"),
  libraryDelete: (item: LibraryItem) => jpost("/library/delete", item),
  libraryVolume: (path: string, intValue: number | null) => jpost("/library/volume", { path, intValue }),
  librarySpeed: (path: string, doubleValue: number | null) => jpost("/library/speed", { path, doubleValue }),
  // live drag preview — set the playing wallpaper's volume/speed NOW, no persist (see /preview)
  // API: paths = the item(s) being edited; omitted = whatever is playing; global = the Settings page's
  // global sliders (every live wallpaper without its own override for that field — override ?? global)
  preview: (body: { volume?: number; speed?: number; paths?: string[]; global?: boolean }) => jpost("/preview", body),
  libraryWhitelist: (path: string, value: boolean) => jpost("/library/whitelist", { path, value }),
  // API: a crashed scene playable again (the backend broadcasts library-item-changed {hasCrashed: false})
  libraryClearCrash: (path: string) => jpost<{ cleared: boolean }>("/library/clear-crash", { path }),
  // API: a scene's user properties (project.json general.properties) — list, set (saved per item + live),
  // reset (name: one, none: all), and the drag twin (live, nothing saved)
  sceneProps: (path: string) => jget<ScenePropsResp>(`/library/scene-props?path=${encodeURIComponent(path)}`),
  setSceneProp: (path: string, name: string, value: unknown) => jpost<ScenePropsResp>("/library/scene-props", { path, name, value }),
  resetSceneProp: (path: string, name?: string) => jpost<ScenePropsResp>("/library/scene-props", { path, name, reset: true }),
  previewSceneProp: (path: string, name: string, value: unknown) => jpost("/library/scene-props/preview", { path, name, value }),
  librarySync: () => jpost<{ added: string[] }>("/library/sync"),
  // API: the offline scene loudness estimate (a background queue, one nice'd child at a time): queue every scene (or
  // `paths`) — `force` recalculates what's already estimated for its current configuration —, cancel, status
  sceneLoudnessEstimate: (force: boolean, paths?: string[]) => jpost<{ queued: number }>("/library/scene-loudness/estimate", { force, paths }),
  sceneLoudnessCancel: () => jpost<{ cancelled: boolean }>("/library/scene-loudness/cancel"),
  sceneLoudnessStatus: () => jget<SceneLoudnessStatus>("/library/scene-loudness/status"),
  trash: (items: LibraryItem[]) => jpost<{ batch: string }>("/library/trash", { items }),
  undo: () => jpost<{ ok: boolean; count: number; title: string | null }>("/library/undo"),
  undoDepth: () => jget<{ depth: number }>("/library/undo-depth"),
  libraryOps: () => jget<{ ops: LibraryOp[] }>("/library/ops").then((r) => r.ops),
  download: (source: number, result: Wallpaper, apply: boolean, signal?: AbortSignal) =>
    // `skipped`: the user skipped / stopped it in the Steam to-do — not a failure
    jpost<LibraryItem & { error?: string; skipped?: boolean; message?: string }>("/download", { source, result, apply }, signal),
  steamcmdSignin: () => jpost("/steam/steamcmd-signin"),
  transitions: () => jget<TransitionEffect[]>("/transitions"),
  // cache-bust frag/vert: the GLSL is regenerated during dev, and a stale Electron HTTP-cache
  // entry would replay an old (possibly broken) shader. Tiny text, fetched once per picker open.
  transitionFragUrl: (id: string) => withToken(`${API}/transitions/frag/${encodeURIComponent(id)}?t=${Date.now()}`),
  transitionVertUrl: () => withToken(`${API}/transitions/vert?t=${Date.now()}`),
  transitionPreviewUrl: (which: "a" | "b") => withToken(`${API}/transitions/preview/${which}`),
  playlistState: () => jget<CustomPlaylist | null>("/playlist/state"),
  savePlaylistState: (p: CustomPlaylist) => jpost("/playlist/state", p),
  playlistNames: () => jget<string[]>("/playlist/names"),
  savePlaylist: (name: string, playlist: CustomPlaylist) => jpost("/playlist/save", { name, playlist }),
  loadPlaylist: (name: string) => jpost<CustomPlaylist | null>("/playlist/load", { name }),
  playPlaylist: (paths: string[], settings: PlaylistSettings) =>
    jpost<{ message: string }>("/playlist/play", { paths, settings }),
  playFrom: (paths: string[], startIndex: number, settings: PlaylistSettings) =>
    jpost<{ message: string }>("/playlist/play-from", { paths, startIndex, settings }),
  steamStatus: () => jget<{ signedIn: boolean; rejected?: boolean; accountName: string; daysLeft: number | null; mode: string }>("/steam/status"),
  qrStart: () => jpost("/steam/qr/start"),
  qrCancel: () => jpost("/steam/qr/cancel"),
  signout: () => jpost("/steam/signout"),
  // API: the password sign-in (SteamOps). The password goes in this one request body and nowhere else; the code steps
  // come over WS (steam-login-code) and are answered by loginCode. A refused start / code → Error(backend's words).
  steamLogin: (username: string, password: string) => jpost("/steam/login", { username, password }),
  steamLoginCode: (code: string) => jpost("/steam/login/code", { code }),
  steamLoginCancel: () => jpost("/steam/login/cancel"),
  deleteFromSource: (items: LibraryItem[]) => jpost<{ batch: string }>("/workshop/delete-from-source", { items }),
  drain: () => jpost("/workshop/drain"),
  workshopQueue: () => jget<{ pending: string[]; hasPending: boolean }>("/workshop/queue"),
  // API: "Open on Steam" → the Steam CLIENT (steam://url/CommunityFilePage/<id>, its own route — /open is http(s) only);
  // ok:false = the Steam app couldn't be opened → the caller falls back to the https page (openOnSteam below)
  openSteamPage: (workshopId: string) => jpost<{ ok: boolean }>("/steam/open-page", { workshopId }),
  // API: the Browse sidebar's subscription toggle (Web/WorkshopSubOps.cs) — state from disk + the queue + the to-do only
  workshopState: (ids: string[]) => jpost<Record<string, WorkshopSubState>>("/workshop/state", { ids }),
  workshopSubscribe: (workshopId: string, title: string) =>
    jpost<{ subscribed: boolean; inSteamTodo: boolean; message: string }>("/workshop/subscribe", { workshopId, title }),
  workshopUnsubscribe: (workshopId: string, title: string) =>
    jpost<{ inLibrary: boolean; batch: string | null }>("/workshop/unsubscribe", { workshopId, title }),
  // the Browse sidebar's creator, favourite and comments; favourite / post without a sign-in → ApiError.signIn
  workshopCreator: (id: string, owner?: string | null) =>
    jget<WsCreator>(`/workshop/creator?id=${encodeURIComponent(id)}${owner ? `&owner=${encodeURIComponent(owner)}` : ""}`),
  workshopFavorite: (id: string) => jget<{ signedIn: boolean; favorited: boolean | null }>(`/workshop/favorite?id=${encodeURIComponent(id)}`),
  workshopSetFavorite: (workshopId: string, favorite: boolean) => jpost<{ favorited: boolean }>("/workshop/favorite", { workshopId, favorite }),
  workshopComments: (id: string, owner: string | null | undefined, start: number, count: number) =>
    jget<WsComments>(`/workshop/comments?id=${encodeURIComponent(id)}${owner ? `&owner=${encodeURIComponent(owner)}` : ""}&start=${start}&count=${count}`),
  workshopPostComment: (workshopId: string, owner: string | null | undefined, text: string, count: number) =>
    jpost<WsComments>("/workshop/comment", { workshopId, owner, text, count }),
  // "Unsubscribe without deleting": its own route; the library copy is kept (kept = links turned into the library's own copy)
  workshopUnsubscribeKeep: (workshopId: string, title: string) =>
    jpost<{ inLibrary: boolean; kept: number }>("/workshop/unsubscribe-keep", { workshopId, title }),
  // API: the Steam to-do (the pages the user clicks in the Steam app, one at a time — .claude/rules/backend/sources-steam.md § Workshop downloads)
  steamTodo: () => jget<SteamTodo>("/steam-todo"),
  steamTodoAction: (a: "next" | "reopen" | "skip" | "stop" | "use-steam-app") => jpost<{ error?: string | null } | void>(`/steam-todo/${a}`),
  open: (body: { path?: string; url?: string; reveal?: boolean; isScene?: boolean; workshopId?: string | null; copiedSceneDir?: string | null }) => jpost("/open", body),
  // API: a library video / GIF in the desktop's default app for its type — 403 for anything else (.claude/rules/backend/api.md § Security)
  openMedia: (path: string) => jpost("/open/media", { path }),
  duration: (path: string) => jget<{ seconds: number }>(`/library/duration?path=${encodeURIComponent(path)}`),
  apply: (path: string) => jpost("/apply", { path }),
  stop: () => jpost("/stop"),
  next: () => jpost("/next"),
  prev: () => jpost("/prev"),
  random: () => jpost("/random"),
  pause: () => jpost("/pause"),
  current: () => jget<{ path: string | null; sceneId: string | null; playing: boolean; timed: boolean; position: number | null; keep?: boolean }>("/current"),
};
