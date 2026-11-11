---
paths:
  - "src/backend/Web/**"
  - "src/backend/Program.cs"
---

# Web backend (`serve`)

The C# app gained a headless web backend for the Electron/React UI. **All scrapers, helpers,
services, models, CLI flags and daemons are unchanged** — `Web/` only wraps them.

## Entry
`Program.cs` `serve` branch → `Web/ServerHost.Run`. Kestrel binds **127.0.0.1:0** (random free
port; `LIASCAPE_PORT` pins it — the Electron shell passes the previous launch's port while it's free, since the
UI's origin IS that port and a new origin per launch reset every localStorage pref; dev pins 5174), writes
it to `~/.config/liascape/serve.port` (Electron reads it), after the API token `serve.token` beside it — every
request needs it (§ Local API security below). Loopback-only — which is NOT private: that section says why.
All other subcommands (`restore`, `random`, `kill`, the keybind actions, the internal `monitor-daemon`/`timer-daemon`/`restart-daemon`)
and the daemons keep their behavior. **`liascape <action>` is handed to a running backend**
(`Web/ActionForward`: `serve.port` → `GET /health` must answer `{ok:true}` → `POST /action {name}` with the
`serve.token` header), which
runs it on its own session state (`AppOps.RunAction` — the same switch the CLI runs) so the UI hears about
it: run in the one-shot process, a single-session next/prev/random switched the wallpaper behind the
backend's back (stale history, the UI kept marking the old one playing). It runs locally only when no
backend answers `/health`; once the POST is sent it never falls back (a doubled next skips one, a doubled
toggle undoes itself). Unknown action → exit 1 with the list. A keybind slower than 1.5 s prints its
phases to stderr (`slow — runtime start / init / forward`; unloaded the whole CLI is ~0.14 s — the UI
matrix saw 6–15 s only under the owner's desktop load, the forward itself < 1 s), and `/action` logs any
run over 500 ms.

## Local API security (owner 2026-11-11: "make the app as a whole more secure")
**Threat.** `127.0.0.1` is reachable by every web page open in the user's browser (a `fetch`/`<img>`/`<form>`/WebSocket to
`http://127.0.0.1:<port>`, and DNS rebinding: `evil.example` re-resolved to 127.0.0.1 makes the API "same-origin" for that
page) and by every other local user. Until 2026-11-11 the API answered all of them, with `Access-Control-Allow-Origin: *`:
any website could read `GET /settings` (the Steam refresh token, web cookie, `steamLoginSecure` → the Steam session),
`GET /media?path=~/.ssh/id_rsa`, use `/img` as a proxy into the LAN, `POST /open` (xdg-open anything), `/action`, a settings
change, `/steam/steamcmd-signin` (its username was pasted into an `sh -c` string → shell commands), the WS. **`Web/ApiSecurity.cs`**,
the first middleware (before the error handler — a refusal never runs an endpoint):
- **The token.** `serve` start (`ApiSecurity.InitToken`, before Kestrel listens) reads `~/.config/liascape/serve.token` —
  reused while it's 43 base64url chars and 0600 (a backend restarted under an open page — `dotnet watch`, the matrix's
  `restart:*` cells — keeps answering the page's token), else 32 random bytes — and writes it 0600 (temp + rename) BEFORE
  `serve.port` (a client that sees the port finds the token). The Electron shell deletes it before it starts its own
  backend → **a new token per app launch**. Same dir as `serve.port`, not `$XDG_RUNTIME_DIR`: a hermetic test that keeps the
  session's runtime dir would overwrite the owner's. Every request presents it — header **`X-Liascape-Token`**, or
  **`?token=`** on a GET/HEAD only (an `<img>`/`<video>` src and the WebSocket can't send headers; a write must use the header,
  which a foreign page can't set without a preflight it fails). Compared in constant time. **401 `{error}`** otherwise.
  Exempt: `GET /health` (liveness for scripts / `ActionForward`; says nothing) and the static UI files (`LIASCAPE_UI_DIR`:
  `/`, any file that exists there — the public bundle; its page gets the token from its URL).
  Why a query param and not a cookie for media: a cookie is ambient — sent with requests any page triggers (a localhost
  dev server of anything is same-site with 127.0.0.1's cookies under SameSite rules, the YouTube iframe's requests too),
  i.e. CSRF again; a capability only the app's page holds can't be ridden. The URL token stays in our origin (the default
  `strict-origin-when-cross-origin` referrer sends only the origin elsewhere), and the page drops `?token=` from its own URL.
- **Host** must be `127.0.0.1:<port>` or `localhost:<port>` (the connection's local port) — DNS rebinding arrives as
  `Host: evil.example:<port>` → 403. Static files too.
- **Origins.** A request with an `Origin` that isn't its own (`http://127.0.0.1|localhost:<port>`) gets **403** unless the
  origin is allowed: the Vite dev UI (`http://localhost:5173`, `http://127.0.0.1:5173`) **only while this backend serves no UI
  itself** (no `LIASCAPE_UI_DIR`: `dotnet watch -- serve`, `dotnet run -- serve`; production and the launcher set it → none),
  plus `LIASCAPE_DEV_ORIGINS` (comma list; a file:// page fetches as `null` and opens its WebSocket as `file://` — the UI matrix sets `null,file://` for `restart:initDown`). An allowed
  one gets `Access-Control-Allow-Origin: <it>` + `Vary: Origin`; its preflight (OPTIONS + `Access-Control-Request-Method`) is
  answered here without the token (a preflight never carries header values): methods GET/POST, headers `Content-Type,
  X-Liascape-Client, X-Liascape-Token`, max-age 7200. The old `UseCors` (and the lead's stopgap `WithOrigins`) is gone.
- **Headers** on every answer: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`; `/media` `/img` `/anim` `/still`
  also `Content-Security-Policy: sandbox; default-src 'none'` (served bytes — a WE "web" wallpaper's index.html, a proxied
  page — never run as a document with this origin's rights). `/img` passes only an `image/*` / `video/*` Content-Type
  through, else `application/octet-stream`.
- **Local files** (`ApiSecurity.MediaAllowed`): `/media`, `/anim` + `/still` with a local path, `/library/duration` and
  `/open`'s reveal serve only absolute paths without a `..` segment under: the data dir `~/.local/share/liascape` (the
  library — its `local/<id>` links into Steam's folders are followed, the request path stays inside), the caches
  `~/.cache/liascape` + `$XDG_CACHE_HOME/liascape`, the settings' `WorkshopFolder` (WE-local Browse cards, their reveal;
  cached 2 s, re-read on a miss — a folder just changed in Settings never leaves its thumbnails blank; never `/`). Else
  **403**. That is every path the UI hands `media()` / `thumb()` / `anim()` / `still()` (library items, WE-local results and
  details). `LibraryStore.Locate` refuses a `..` segment too (Delete / Trash of a crafted path touch nothing).
- **Remote fetches** (`/img`, remote `/anim` + `/still`): http(s) only, and every resolved address public — never loopback,
  RFC 1918, CGNAT, link-local (169.254 = cloud metadata), ULA / site-local / multicast / NAT64 v6 (`IsPublic`). Checked up
  front (**403 `{error}`**) and again at every connect (`PublicOnlyHttp`'s `ConnectCallback` connects only to a checked
  address — a DNS answer changed in between, a redirect to a private host). No HTTP proxy for these (a local one would be
  refused by the same rule).
- **`POST /open`**: `url` must be http(s) (→ `xdg-open` with one argument; else 400); otherwise only `{path, reveal: true}`
  with the path (and `copiedSceneDir`) passing `MediaAllowed` and a digits-only `workshopId` (403) — no bare path (xdg-open
  runs a `.desktop` file), no `file:`/custom scheme. (A Steam-client `steam://` route would be its own endpoint.)
- **Secrets out of the API**: `GET /settings` returns `SettingsService.Redacted` — `SteamRefreshToken`,
  `SteamAccessToken`, `SteamLoginSecure` empty (the UI never read them; `/steam/status` says signed in or not; POST
  `/settings` keeps the saved ones whatever the body says, so the UI posting its copy back changes nothing). `settings.json`
  is written 0600 (its temp file is created 0600; the rename keeps it — an older 0644 file turns 0600 at its next save).
  The secrets stay in settings.json (not a separate file / the keyring): with the file 0600 a second file adds nothing
  against another user or a web page, and every Steam call site reads them from `AppSettings`. No log line prints them.
- **Command lines**: the steamcmd sign-in terminal's `sh -c` script takes the steamcmd path, the install dir and the
  username as `$1..$3` (were pasted in quotes — a `"; …` in the username ran); `TransitionService`'s ffmpeg calls (legacy
  transitions) take an argument array (were one string with quoted paths — a Workshop item names its own media file in
  project.json, so a `"` in it became extra ffmpeg arguments, an output path included). Every other spawn already used
  `ArgumentList`; `SteamCmdPath` (a settings value run as a program) is by design — it needs the token.
- **How each client gets the token:**
  - **The app (production)**: `app/shell/main.js` deletes `serve.token`, starts the backend, waits for `serve.port`, opens
    `http://127.0.0.1:<port>/?token=<serve.token>` (`api-auth.js` `withToken`). The page (`api/client.ts`) keeps it in
    `sessionStorage` (`liascape_token` — a reload keeps it), drops it from the address bar (`history.replaceState`), sends
    `X-Liascape-Token` on every `fetch` (`authHeaders`) and appends `token=` to every src URL it builds (`withToken`:
    `img/media/anim/still`, the transition preview URLs) and the WS URL (`api/events.ts`); the freeze heartbeat too.
  - **Dev (Electron + Vite)**: main.js opens `http://localhost:5173/?api=5174&token=…` (the systemd backend's file);
    `dotnet watch` restarts keep the file, so the open page keeps working.
  - **Browser dev without Electron**: `http://localhost:5173/?api=<port>&token=$(cat ~/.config/liascape/serve.token)`.
  - **The CLI** (`liascape next` …, `ActionForward`): reads `serve.token` beside `serve.port` → the header (401 = "the running
    app answered HTTP 401", never run locally). `liascape ctl` talks to the player's own socket (`$XDG_RUNTIME_DIR`, 0700) —
    not this API.
  - **Probes / the UI matrix** (`app/shell/probe-*.js`): `require("./api-auth")` — `withToken(U + "/")` for every page
    they load (the file:// one of `restart:initDown` too), `authHeaders()` on their own `fetch`es, in-page fetches read
    `sessionStorage.liascape_token`. The hermetic stack's `HOME`/`XDG_CONFIG_HOME` are exported, so they read the stack's file.
  - **Shell test scripts** (`test-ui-matrix.sh`, `test-liascape-player-adapter.sh`, `test-settings-merge.sh`,
    `test-settings-latency.sh`): a `curl()` wrapper right after their `export HOME=…` adds the header from
    `$XDG_CONFIG_HOME/liascape/serve.token` (read per call). `test-steam-signin.sh`'s node driver wraps `fetch` with the
    header and opens the WS with `?token=`; its curl only asks `/health`.
- **Electron** (`main.js`): `contextIsolation`, `sandbox`, no `nodeIntegration`, `webSecurity` pinned; every webContents:
  `setWindowOpenHandler` → deny (http(s) → `shell.openExternal`), `will-navigate` away from the app's origin → blocked (http(s)
  → the browser), `<webview>` refused — an "Open on Steam" `target=_blank` link used to open steamcommunity.com inside the app
  with the preload's bridge; permissions: only `clipboard-sanitized-write` + `fullscreen`; the `liascape:pick` IPC answers only
  the app's own frame. `LIASCAPE_DEBUG`'s CDP port (:9222) is a debug-only opt-in: anyone local can drive the window then.
- Check: a private backend (own `HOME`/`XDG_*`/`XDG_RUNTIME_DIR`, a free port) and curl: no token → 401, a wrong `Host` → 403,
  a foreign `Origin` → 403 / no ACAO, `/settings` without `FAKE-` secrets, `/media` outside → 403, `/img` → 127.0.0.1 /
  192.168.x / 169.254.169.254 / `[::1]` → 403, the WS 401 / 101, `liascape toggle-pause` forwarded.

- **Dev shells from before the token** (2026-11-11: the owner's installed shell loads the Vite UI without `?token=`, so every
  request would 401 the moment `dotnet watch` restarted onto this): Vite's dev-only plugin (`app/ui/vite.config.ts`
  `devApiToken`, `apply: "serve"`, never in a build) serves `GET /__liascape/token` = serve.token, but only to a
  `Sec-Fetch-Site: same-origin` request (browser-set; another site's fetch is `cross-site` → 403, no header → 403), and
  injects a loader into index.html that fetches it synchronously into sessionStorage before the app module runs (skipped
  when the URL already carries `token`). The HTML itself never contains the token. Checked: same-origin 200, cross-site /
  none 403.

## Files
- **`Web/ServerHost.cs`** — minimal-API endpoints (thin wrappers), the security middleware (`Web/ApiSecurity.cs`), static
  serving of the built UI when `LIASCAPE_UI_DIR` is set (→ same-origin, UI uses relative paths), image
  proxy, `/media`, WebSocket `/events`. Providers array order == the UI source-pill order; WE-local
  (index 3) `available:false` when `AutoAddWeWallpapersToLibrary`.
- **`Web/EventBus.cs`** — WS broadcaster. **Replaces PlayerHelper's `Action?` callbacks**
  (`OnWallpaperChanged`/`OnSceneCrashed`/`OnTimedPlaylistStopped`) — wired in `WirePlayer()`. Per-socket
  send is serialized (concurrent `SendAsync` on one socket throws).
- **`Web/AppOps.cs`** — backend orchestration: `PlayPlaylist`/`PlayFrom`
  (effective-settings: override-global vs global), `DownloadAsync` (web + workshop-acquire), `Trash`
  / `Undo` / `DeleteFromSource` (below), `SavePlaylistState` (`/playlist/state`'s body: save + live
  reorder/rotation of a running timed playlist — trash/undo go through it too — and a change of its
  transitions re-arms an aligned switch already armed for A's end, `PlayerHelper.RearmAlignedSwitch`:
  under liascape-player that switch was requested with the old effect/duration; `/settings` does the same for
  the global transitions and `TransitionMethod`), `RunAction` (keybinds).
- **Trash** (`AppOps.Trash`, old-app parity): the items leave the **playlist** too (live — a running
  rotation never plays a trashed file; an armed aligned switch to one is re-armed), the batch remembers
  each one's playlist index and **Undo puts it back there** (+ un-queues a delete-from-source
  unsubscribe). If one was **on screen or incoming** (liascape-player: `LiascapePlayerMedia.ShownOrIncomingPaths` —
  every layer's content, an effect's `to`, every requested switch's B except an aligned one still waiting
  for A's end; `cur:*` alone missed a switch requested but not yet running; legacy: the current file), a
  playlist session plays on from the **next surviving playlist bar item after it** (`PlayFrom`, wrapping; under
  liascape-player the program's items lose it — the bar's survivors — then `program.next`, which goes on from its old
  place: player-adapter.md § Rotation), a single one stops. The UI drops the items from its playlist bar before the request and re-reads
  `/playlist/state` after trash and undo (a stale playlist bar saves itself back over the backend's).
- **`POST /playlist/state` merges too** (`JsonMerge.Over` over the saved state: a partial body keeps the rest, a
  nested `settings` merges key by key, lists replace) — a paths-only body used to reset the rotation and
  transitions to the C# defaults (matrix `plState:partial`). The UI still posts its whole playlist bar.
- **`PlayFrom`** plays `[clicked, rest…]` but persists the playlist bar in **its own order** (`persistPaths`) —
  persisting the play order reordered the playlist bar on the next launch.
- **Removing the playing item from the playlist bar** (X / context menu → `/playlist/state` without it): it keeps
  playing, and the rotation goes on from **its place** — the first item after it in the previous list
  that's still there (`ReorderPlaylist(…, previousPaths)`; like Trash). It went on from the top of the new
  list (removing item 5 of 10 replayed 1–4). Only for an edit of the same list (nothing added): a
  different playlist loaded over it starts at its own top.
- **`Web/SteamOps.cs`** — QR login (→ WS `steam-qr` PNG via QRCoder, `steam-signed-in`), the password sign-in (below),
  status (daysLeft), signout, unsub drain (→ WS `unsub-progress`, Interlocked one-at-a-time; without a usable sign-in its
  items go into the Steam to-do — `sources.md` § Unsubscribe).
- **`Web/SteamTodo.cs`** — the Steam to-do (owner 2026-11-11, `sources.md` § Download): ONE app-wide queue of the Workshop
  pages the user clicks in the Steam app, one at a time; only the user's Next moves on. Its endpoints are one-line wrappers.

## Endpoints (all under `http://127.0.0.1:<port>`)
`GET /health /health/features /sources /settings /themes /mpv-preview /player-engine /library /current /workshop/queue /steam/status
/playlist/state /playlist/names /library/undo-depth /library/duration /library/scene-props?path= /library/scene-loudness/status`,
`POST /browse /detail /settings /apply /stop /action /next /prev /random /pause /volume /mute /download /open
/preview /library/{delete,clear,volume,speed,whitelist,sync,import,trash,undo,scene-props,scene-props/preview,scene-loudness/estimate,scene-loudness/cancel} /playlist/{state,save,load,play,play-from}
/steam/{qr/start,qr/cancel,signout,login,login/code,login/cancel} /workshop/{delete-from-source,drain}
/steam-todo/{next,reopen,skip,stop,use-steam-app}`, `GET /steam-todo`, `GET /img?u=&r=` (proxy,
Firefox UA + Referer for moewalls), `GET /media?path=`, WS `/events`.

**`POST /settings` merges (PATCH semantics)** — `SettingsService.Patch` → `Merge`: the body's keys overwrite
the saved settings, every key it leaves out keeps its saved value. It bound the body as the whole
`AppSettings`, so a partial one reset every other field to its C# default (an agent's `{"Volume": 50}`:
~15 fields incl. `SceneMonitors` and `PlayerEngine` → a live engine switch). Each key binds exactly as the
whole body did (the API's web JSON defaults: camelCase or PascalCase keys, the setters' clamps); a value
replaces its field as a unit — an array (`SceneMonitors`, `GlobalTransitionEffectIds`) is the whole new
list, an object the whole new object; an explicit `null` sets null (on a value-type field it's a bad
value); unknown keys are ignored; a bad value (wrong type, a non-object body) is a **400 `{error}`** that
saves nothing. `LastSession` + the Steam sign-in (tokens, `SteamId`) keep their saved values whatever the
body says (the UI's copy is stale; a stale `SteamId` 0 used to get through and leave a signed-in account
with no web cookie). One poster at a time (a lock around load → merge → save): parallel partial bodies all
land (without it 64 of 80 were lost). The UI still posts its whole copy, so it behaves exactly as before;
`prev` → `cur` for the live-apply diff = the saved settings → the merged ones, so a partial body applies
live like any other. Hermetic test: `scripts/test-settings-merge.sh` (liascape-player headless, ~10 s).

**Live-apply:** `/library/volume|speed` save the override (dropped when == global) then `PlayerHelper.ApplyOverrideLive` retargets the *playing* wallpaper instantly (mpv IPC / `pactl` for scenes). `/preview` is the throttled drag-preview twin — sets mpv/LWE volume|speed NOW with **no persist** (the modal throttles it during a slider drag, then persists once on release). **`/preview {volume|speed, global:true}`** is the Settings page's global sliders' twin (`PlayerHelper.PreviewGlobal`): every live wallpaper WITHOUT its own override for that field takes the dragged value (override ?? global, R61 — an overridden one never moves); liascape-player: one `set` per following source from the cached source map; legacy: the current item when it has no override. **A no-op `/settings` costs ~5–10 ms** (300-item library, `scripts/test-settings-latency.sh`): it used to be 0.15–0.5 s because `_ = LibraryService.BackfillLoudnessAsync()` ran the whole library scan synchronously on the request thread (an `async` method runs until its first real await — with every item measured, that was all of it) and parsed `index.json` twice per item; now `KickLoudnessBackfill(force: just switched on)` runs it on the thread pool, at most once per 30 s otherwise, reading each index once. The handler logs its phases when it takes > 100 ms (`/settings: N ms (load+save …, backfill …)`; always with `LIASCAPE_PROFILE_SETTINGS=1`). `/settings` applies the *effective* (`override ?? global`) value so a global change never clobbers an active override — and the volume keybinds (`AppOps.VolumeKey` → `PlayerHelper.AdjustVolume`: `liascape volume up|down`, `/volume {delta}`) move what **`VolumeKeyTarget`** (Advanced → "Volume keys adjust") says: `auto` (default) the playing wallpaper's own volume when it has one, else the global; `item` always the playing wallpaper's own (giving it one); `global` always the global — an overridden wallpaper then keeps its own (it used to get the new global pushed and snap back on the next settings save). An item change saves + live-applies like `/library/volume` and broadcasts WS `library-item-changed {path, volumeOverride}` (the grid takes it, and the item sidebar reads the grid's copy); a global one goes through `SettingsService.Update` (the `/settings` lock) and broadcasts `settings-changed {volume}`. Matrix `cli:volume-up|down:overridden|item|global`, `cli:volume-up:modalOpen`. Normalization is applied to every live source by its own item, and again the moment a background loudness measurement lands (`PlayerHelper.OnLoudnessMeasured`) — an item that started unmeasured used to play un-normalized until its next switch. Under liascape-player a WE scene is normalized too: the player learns its loudness on first play (`scene.loudness` → the index → its source's `gain.normalize`, ramped; `player-adapter.md` § Scenes → "Loudness"). It also live-applies `VideoScale` (mpv `panscan`). The rotation (interval — the minimum play time under advance-on-end —, advance-on-end, `GlobalMaxPlaySeconds`; a playlist's own via `/playlist/state`) applies live to the running rotation (`PlayerHelper.ApplyRotationLive` / `ApplyMaxPlayLive`, the effective values, diffed — `player-adapter.md` § Rotation). A `PlayerEngine` change in `/settings` switches the engine live (`PlayerHelper.SwitchEngineLive` — see `player-adapter.md`). Under liascape-player a `SceneMonitors` change applies live too (`LiascapePlayerMedia.ApplySceneFps` — each monitor's fps → `out:<name>.scene_fps`, diffed; legacy: launch-only, LWE can't reconfigure), and `GET /player-engine` carries `scenes {available, reason, assets_dir}` (can a scene play now, and why not — `player-adapter.md` § Scenes) and `vram {low_active, mode}` (the player's low-VRAM hold). The GPU / VRAM settings (`AutoThrottleScenes`, `LimitVramPerScene` + `SceneVramLimitMib`, `VramLowMode`) apply live too (`LiascapePlayerMedia.ApplyGpuSettings` → `player.scene_throttle` / `scene_vram_limit_mib` / `vram_low_mode`, diffed; `player-adapter.md` § Scenes). Under liascape-player every live-apply above — `/settings` (one pass for all of it), `/library/volume|speed`, `/preview`, the volume keys, normalization, mute — is a pass of ONE effective-settings resolver: each live source (either side of an effect, a pending B) gets its own item's value, diffed against what it runs (`player-adapter.md` § Targeting). `/open` reveals an item in the file manager (resolves the symlink / scene dir). `/library/duration` = ffprobe.
**Scene properties** (`AppOps.SceneProps/SetSceneProp/PreviewSceneProp`; library.md § "Scene properties"):
`GET /library/scene-props?path=<scene folder>` → `{path, engine, live, note, props: [{name, type, label, order,
condition, visible, editable, unsupported, default, value, overridden, min, max, step, fraction, precision, options}]}`
(display order; `value` = override ?? default; `visible` = its condition over the effective values; `live` false +
`note` under legacy — LWE takes them at launch only). `POST /library/scene-props {path, name, value}` saves one
(field-level, the index lock; == default → dropped), `{path, name, reset: true}` resets one, `{path, reset: true}` all
— then live on the item's source(s) (`PlayerHelper.ApplyScenePropsLive`) — and answers the new list; a bad value / an
unknown name / a non-editable type / not a scene folder → **400 `{error}`**, nothing saved. `POST
/library/scene-props/preview {path, name, value}` = the drag twin (live, nothing saved).

**Scene loudness** (`Web/SceneLoudnessOps.cs` — the queue — + `Helpers/SceneLoudnessPlanner.cs` — the CLI run and the
store; library.md § Loudness, player-adapter.md § Scenes → "Loudness"; docs/TODO.md "Offline scene loudness →
integration"): a scene's loudness ESTIMATED from its files by `liascape-player scene-loudness <dir> --props '<its
scene_props>'` (the player's own estimator; per-file decode cached in `~/.cache/liascape/scene-loudness`, so a repeat is
a re-mix, ~1–4 ms + the spawn). **One background child at a time** under `nice -n 19 ionice -c3` (each when on PATH),
`LD_LIBRARY_PATH` dropped, 600 s bound, never on a request thread, never touching playback (read-only on the scene).
**Cancel-safe:** a scene's result is written to its index entry atomically (`SetMeta`) only when its child succeeded;
cancel kills the running child and drops the queue (what's stored stays); a run cut short by a restart is picked up by
the next startup pass. **Fed by:** an import (`/download` — a Workshop download, a WE local add — and `/library/import`:
`Imported`, the item if it's a scene), `/library/sync` and the `serve` startup after its WE sync (`AfterImport`: every
library scene WITHOUT an estimate for its stored configuration — a new one, one whose folder was incomplete last time:
`SceneDir::open` fails on a half-downloaded item, so the next sync retries it), and the endpoints — all no-ops without
a `liascape-player` binary. `POST /library/scene-loudness/estimate {paths?: [...], force?: bool}` → `{queued}` (no paths
= every library scene; without `force` a scene already estimated for its current configuration is skipped — Settings'
**Estimate**; `force` = **Recalculate all**; a path already queued counts once); `POST /library/scene-loudness/cancel`
→ `{cancelled}` (false = nothing ran); `GET /library/scene-loudness/status` → `{running, done, total, current, failed:
[{path, error}]}` (the last run's). WS **`scene-loudness-progress {done, total, currentId, finished?, cancelled?}`**
(shaped like `unsub-progress`; `finished` once per run) + **`library-item-changed {path, loudnessLufs,
loudnessEstimated, loudnessSeconds, loudnessConfidence, loudnessNote}`** per stored scene (and per stored live report).
Adapter log: `scene loudness: queued N scene(s) (why)`, `… not estimated — <error>`, `… finished — D done, S stored, F
failed in T s`. A property commit re-plans at normal priority (`LiascapePlayerMedia.Replan`, not this queue).
`/library` items carry `loudnessLufs / loudnessEstimated / loudnessSeconds / loudnessConfidence / loudnessNote` for a
scene (`LibraryService.SceneLoudnessInfoOf`). Measured: the owner's 96 scenes in 9.8 s (warm cache), 0 failed.

**`GET /health/features`** (`Helpers/FeatureHealth.cs`, owner 2026-10-28 "make missing libraries fail loudly") →
`{features: [{id, label, ok (true | false | null = unknown), reason, affects (AppSettings keys, camelCase — the Settings
rows that get a warning icon), inUse (switched on / selected now — the summary lists only those)}]}`. Never spawns a
player: liascape-player's pieces come from the running player's `hello.health` (one quick `hello`), else `liascape-player health` +
`scene-check` in the backend's environment (cached 30 s); tools by a PATH lookup. `Build(Inputs)` is pure (self-test
`FeatureHealthAssertions`), `Report(s)` gathers. The table:

| id | needs | when missing | affects |
|---|---|---|---|
| `liascape-player` | the `liascape-player` binary (`PlayerEngine.ResolveBinary`) | the engine falls back to legacy | `playerEngine` |
| `scenes` | liascape-player: `liascape-scene-worker` (built with LWE's core) + WE's assets dir (player's `hello.health.scenes` / `scene-check`); legacy: `linux-wallpaperengine` | scenes are skipped | `allowScenes` |
| `transitions` | liascape-player: the effects catalogue the player loaded (`transitions/`); legacy: `liascape-transition` + the catalogue | every switch is a cut | `globalTransitionEnabled`, `transitionMethod`, `transitions` |
| `vram` (liascape-player) | a VRAM probe — NVML (`libnvidia-ml`), AMD DRM sysfs, or `nvidia-smi` (Intel: none) | the per-scene VRAM limit and the low-VRAM rule can't act | `limitVramPerScene`, `sceneVramLimitMib`, `vramLowMode` |
| `hwdec-interop` (liascape-player) | the render worker's GL interop (CUDA on NVIDIA, VA-API on AMD/Intel) — running player only (null otherwise) | hardware decoding copies every frame through the CPU | `hwDec` |
| `auto-mute` | liascape-player: the player's auto-mute Signal (`hello.health.automute`: `LIASCAPE_PLAYER_AUTOMUTE` not `0`, its audio bus up; null before a player ran) — nothing else; without it `AudioMonitor`'s `pactl` + `parec`, and the reason says it works only while the app is open. Legacy: `pactl` + `parec` | auto-mute can't hear other apps (or only with the app open) | `autoMute` |
| `audio-bus` (liascape-player) | the player's own PipeWire audio bus (`hello.health.bus`: up / re-targeting = ok; null while the first session is set up and with no player running) | the sources play on mpv's default device instead — nothing stops, but there is no bus meter and no in-player auto-mute (the `auto-mute` row says that part) | none — no setting row of its own, so it shows in the Settings summary only (always "in use") |
| `mpris` | liascape-player with the Signal: a D-Bus session bus (`SessionBusReachable`); else / legacy: `playerctl` | "Only if MPRIS player active" never sees a player | `autoMuteOnlyIfMprisActive` |
| `ffmpeg` | `ffmpeg` + `ffprobe` | no loudness measurement, imports / thumbnails / durations fail | `normalizeAudio` |
| `steamcmd` | steamcmd (`WorkshopDownloader.FindSteamCmd`) | "Download via steamcmd" can't download | `workshopDownloadMode`, `steamCmdPath` |

Not listed (checked, no silent degradation to report): `wl-copy` (the UI copies with `navigator.clipboard`, no
`wl-copy` call exists), `grim` / `mpvpaper` (legacy only — the owner runs liascape-player). The PipeWire audio bus used to be here
("nothing stops"); it is the `audio-bus` row now (player-core.md § health) so the fallback to mpv's default device is
visible. Guards: `--probe probe-health.js` (matrix stack; RED on
the base UI), the adapter IT's `LIASCAPE_SCENE_WORKER_BIN=/nonexistent` section (`hello.health` + the endpoint; the same section asserts `bus` off under `--ao null`, the private-PipeWire part asserts it up), self-test `FeatureHealthAssertions`.

## WS event types
`wallpaper-changed {path}` (every switch — `SwitchToFile`; `null` on a keybind stop / trash stop) `· settings-changed
{…changed fields}` (the backend changed settings itself — a keybind volume-up/down; the UI merges it:
every UI save posts its WHOLE copy, so a stale one reverted the keybind's volume) `· scene-crashed {path}` (legacy: an LWE process died; liascape-player: the scene's `source.broken` — the item is then marked crashed in its index; the UI marks its card at once) `· scene-vram-stopped {path, usedMib, limitMib, message}` (liascape-player: the VRAM guard stopped a scene — not a crash; the UI's status bar shows the message) `· timed-stopped · download-progress {id,value,done?,status?} (`status`: a Workshop download's step in words — "Subscribing on
Steam…", or without a usable sign-in "Not signed in to Steam here — click Subscribe in Steam, then it downloads by itself…")
· unsub-progress {done,total,currentId,finished?, openedInSteam?, message?, error?} (the finishing one: `message` = what to click in the Steam app when it
did the unsubscribing, or that Steam is rate-limiting) · steam-todo {action: subscribe|unsubscribe, index, total, remaining,
current: {id, title}, delivered, message, busy} | {finished: true} (the Steam to-do, on every change — below) · library-synced {count} (the startup one fires before any open page has
reconnected — a page re-reads everything on a WS reopen instead: `web-ui.md` → "Backend restart under an open page") · library-item-changed {path, …only the changed fields} (a volume keybind moved an item's own volume → `volumeOverride`; a scene's loudness estimate / report → `loudness*`) · scene-loudness-progress {done,total,currentId,finished?,cancelled?} · steam-qr {png}
· steam-signed-in {…status} · steam-qr-error {message} · steam-login-code {kind: email|device|confirm, hint, retry} ·
steam-login-error {message, rateLimited} · steam-login-cancelled` (the password sign-in, below).

## The Steam to-do (`Web/SteamTodo.cs`; owner 2026-11-11 — `sources.md` § Download for the why)
- **State**: an ordered list of entries `{id, title, action, hasDownload}`, `[0]` = the current one (its page was opened);
  `index` = entries finished in this run + 1, `total` = finished + remaining (back to 0 when it empties). `delivered` = the
  current entry's download already finished (Steam had it) — it still waits for Next; `message` = the Steam app couldn't be
  opened / reached; `busy` = "Let the Steam app do all N" is probing Steam.
- **`GET /steam-todo`** → that payload (or `{finished: true}`) — the UI's `resync` reads it (a page opened mid-to-do).
- **`POST /steam-todo/next`** (the user did it: a subscribe entry's download keeps waiting; an unsubscribe → `MarkBlocked`, false
  → re-subscribed), **`/skip`** (subscribe: its `/download` ends `{skipped: true}`; unsubscribe: `Unblock`), **`/stop`** (every
  entry as skipped), **`/reopen`** (the current page again), **`/use-steam-app`** → `{error}` (null = handed to the Steam client;
  else why not, and the to-do is unchanged). All 200, no-ops on an empty to-do. Behind the API token like every route.
- **`POST /download`** answers **200 `{skipped: true, message}`** (not an error) when its to-do entry was skipped / stopped.
- Fed by `WorkshopDownloader` (`EnqueueSubscribe` from the download's page route and `ResubscribeAsync`, `EnqueueUnsubscribes`
  from `UnsubscribeInSteamApp`), `AppOps` (`RememberTitle` on Delete from source; `DropUnsubscribe` on Undo). Log lines:
  `workshop: <id>: subscribe|unsubscribe in the Steam to-do — opened its page in the Steam app`, `… the Steam to-do — done |
  skipped | left`, `the Steam to-do was stopped (N left: …)`, `the Steam to-do hands N to the Steam app (…)`, `… can't use the
  Steam app — <why>`.
- Guards: `scripts/test-steam-signin.sh` (§ 1 selftest: unsubscribes; § 2 + § 3 `h.`: downloads, Skip / Stop, Delete from
  source, "use the Steam app", no `steam-ugc` child on the page route) and `probe-steam.js` `steam:todo` (the panel).

## Steam sign-in by password (`SteamOps.StartPasswordLogin` / `SubmitLoginCode` / `CancelPasswordLogin`)
Owner 2026-11-11: "is it a dead end for users without mobile guard?" — the QR sign-in needs the Steam mobile app. He chose
both: this, and Workshop downloads through the Steam app with no sign-in at all (`sources.md` § Download). Flow:
- `POST /steam/login {username, password}` → 200 (started; a running one is replaced — quietly, no event for it) or **400
  `{error}`** (empty fields, too long, or Steam's rate-limit hold: "…try again after HH:MM"). The body binds to a CLASS
  (`LoginReq`, `ToString` prints no fields — a record's would print the password), `TakePassword()` empties it, and SteamOps
  keeps it in a one-slot box that `SteamAuthService.LoginViaCredentialsAsync` empties when it hands it to SteamKit2's
  `BeginAuthSessionViaCredentialsAsync` (RSA-encrypted there); nothing logs, broadcasts or stores it. Exception messages that
  reach the throwing-endpoint middleware never carry it.
- Steam's next step → WS **`steam-login-code {kind, hint, retry}`**: `email` (Steam Guard by email; `hint` = the address's
  domain Steam sends as `associated_message`), `device` (the mobile authenticator's code), `confirm` (approve in the Steam
  app — `AcceptDeviceConfirmationAsync` returns true so SteamKit2 polls; a code typed meanwhile goes to Steam as the
  authenticator's code via the session's `SendSteamGuardCodeAsync`, a wrong one → `confirm` again with `retry`). A wrong
  email / device code → the same kind with `retry: true` (SteamKit2's own loop asks again). No guard → straight to signed-in.
- `POST /steam/login/code {code}` (spaces / dashes dropped, upper-cased) → 200, or **409 `{error}`** when nothing waits for a code.
- Signed in → `SaveSignIn` (the same fields as the QR path: refresh token, `SteamId`, account name; clears `SteamSignInRejected`
  and the cached cookie) → WS `steam-signed-in {…status}`. Failed → WS **`steam-login-error {message, rateLimited}`** in the
  user's words (`SteamAuthService.LoginMessage`: "Wrong account name or password.", "Steam is limiting sign-in attempts from this
  connection. Wait a while…", expired, refused, unreachable). **Never retried by the backend or the UI**; after a rate limit
  (`RateLimitExceeded` / `AccountLoginDeniedThrottle` / `LimitExceeded` / `AccountActivityLimitExceeded`) new attempts are
  refused for 15 min (`LoginHold`) without reaching Steam. A sign-in that waits > 10 min (`LoginTimeout`) ends with "timed out".
- `POST /steam/login/cancel` → WS `steam-login-cancelled`, nothing saved.
- Log lines (never the password, never the account name): `steam: password sign-in started`, `… Steam asks for the code it
  emailed` / `the authenticator's code` / `waiting for the approval in the Steam app`, `steam: signed in with a password`,
  `steam: password sign-in failed — <message>`.
- Secrets stay behind `SteamAuthService` (`SaveSignIn`, `HasUsableSignIn`, `GetCookieAsync`) so moving them out of
  settings.json later is one place. `GetCookieAsync` no longer asks finalizelogin again once Steam rejected the sign-in.
- Hidden **`liascape-backend steam-selftest`** (needs HOME under /tmp): a scripted sign-in in place of SteamKit2 (the
  `SteamOps.LoginDriver` seam) through every step above + the no-sign-in unsubscribe with a stub `xdg-open`; fails if the
  password appears in any WS event, the console or settings.json. Wrapped with a private-backend download test in
  `scripts/test-steam-signin.sh`.

## Steam Community rate limits (`Helpers/SteamGate.cs`)
**Every** request to steamcommunity.com goes through `SteamGate.SendAsync(req, Kind)` (owner 2026-11-11: "make sure you obey
the rate limits so user dont face ip issues"): Steam limits it per IP and, once tripped, refused for 30+ min — the
owner's browser included. The best request is none: Workshop Browse, its detail's trailer and the trailer cache ask
Steam's CM servers first (next section) and touch steamcommunity.com only as a fallback. Request STARTS are spaced
app-wide (Interactive 0.5 s — fallback Browse pages, a fallback detail's trailer read, subscribe/unsubscribe;
Background 4 s and ≥ 10 s behind the last interactive one — the trailer cache's fallback);
a 429 (or the subscribe 403 "too many", via `Trip`) starts an app-wide cooldown — Steam's `Retry-After`, else 10 min
doubling per repeat (cap 60), reset by a success — saved in `$XDG_CACHE_HOME/liascape/steam-cooldown.json` so a restart
keeps honouring it. During it nothing is sent: `SteamCooldownException` ("Steam is limiting requests from this
connection — try again in N min") → `/browse` answers 429 `{error}` (the UI's `jpost` shows a backend `{error}` in its
own words; Browse puts it in the status bar — only on the fallback path now), the unsubscribe drain stops (`SteamRateLimitException`), the trailer
cache stops and re-schedules itself for the cooldown's end (`TrailerOps.ScheduleAfter`). Never call steamcommunity.com
around it. Not gated: the Steam sign-in (once, user-driven) and api.steampowered.com (another host, its own limits).

## Workshop Browse over Steam's client protocol (`Services/SteamWorkshopService.cs`, `Helpers/WorkshopTags.cs`)
**Why** (2026-11-11): the "Wallpaper Engine (Workshop)" source scraped steamcommunity.com's browse page — 30 items a page,
3 pages + a prefetch of 3 per scroll, AND-only tags, plus a page read per detail click for the trailer — on the host
that locked the owner's browser out. It now asks Steam's CM servers the way the Steam client does, **anonymously**
(SteamKit2 `PublishedFile.QueryFiles`, `SteamWorkshopDetails.QueryAsync`): one app page = one QueryFiles page of 100
(`PageSizeHint` 100), tags / previews (YouTube ids) / full descriptions inline, any page number answered directly.
- **`Helpers/SteamAnonymous.cs`** — ONE shared anonymous session for Browse + the trailer cache + the detail: lazily
  connected, requests serialized, reconnected after a drop, closed after 3 idle min; every call has a deadline
  and returns null (never throws) when the servers can't be reached / refuse — then no retry for 60 s. Measured:
  connect 0.83–1.85 s + anonymous logon 0.38–0.8 s vs one page 0.5–1.3 s, so a session per call made a page 2.3–4 s.
- **Filter** (`WorkshopFilter`, POST /browse `filter`): `{sort, trendDays, include[], exclude[], featureMatch, genreMatch}`; sort →
  `query_type` (trend 3 + `days`, mostrecent 1, lastupdated 21, totaluniquesubscribers 9, toprated 0). Legacy fields
  (`type, ageRating, resolution, genres, features`) still bind: with include AND exclude empty each becomes an include.
- **Semantics** (`WorkshopTags.Build` → `Plan {TagGroups, Excluded, Empty}`; groups Age / Type / Resolution / Genre /
  Features = the filter bar's lists, a tag in no group is its own group): a group's includes are ONE taggroup (OR) —
  an item normally has one genre and exactly one age / type / resolution (500 trending: all exactly 1 genre; "Anime AND Girls" = 4
  items in the Workshop). **Features** are ANDed, each its own taggroup — they stack (500 trending: 0→277, 1→131, 2→63,
  3→17, 4→9, 5→3; "Audio responsive AND Customizable" 46,026 vs OR 407,685) and Steam's own page ANDs them —
  unless `featureMatch: "any"` (owner: "what if a user wants 3D OR HDR and not 3D AND HDR"; default/unknown = all).
  Genres mirror it: `genreMatch: "all"` = every ticked genre required (owner: "lets just have a 'all or any' option for genere
  too"; default/unknown = any) — finds the ~2,800 multi-genre items (mostly 2016–17; Game + Music 180, Anime + Girls 4).
  **Age**: any age include or exclude → a taggroup of the allowed ages (included, else all three, minus excluded),
  which drops the 219 untagged 2017 items (owner: "a 'everyone' user encountering a untagged 'mature' is a tragedy");
  other groups' excludes only go to `excludedtags` (untagged stays). **Type** always = (included or Video+Scene) minus
  excluded, minus Scene when `AllowScenes` is off; Web / Application / Preset always excluded — pages come back full.
  Include+exclude of one tag = excluded. Nothing left to allow → `[]` with no request.
- **Trailer**: QueryFiles results carry `youtubeUrl` + `trailerKnown: true`; `/detail` then reads nothing (0.01 s). A
  fallback result asks the CM session for that one item (`GetTrailersAsync`), the item page only if that fails.
- **Prefetch**: the next page is fetched after the current one (never beside it — the session is serialized) and only
  on the CM path; a stale one (filter change, another page) is cancelled — queued behind it, every filter change took
  ~2 s instead of ~1 s. The filter is compared by value (`Key()`): every /browse re-sends it, and comparing by
  reference had dropped the prefetch on each request.
- **Fallback** (CM unreachable / refused / no answer within 10 s; `LIASCAPE_WORKSHOP_FALLBACK=1` forces it): the browse
  page via SteamGate, 2 pages of 30 per app page, no prefetch; `requiredtags[]` = the plan's single-tag groups (a group
  with one allowed tag, every ticked feature under "all"), the rest (OR groups, excludes, the age rule) filtered on
  each result's tags (`WorkshopTags.Matches`). Its cooldown → 429 as above — the CM path never 429s. Log once per
  path change: `browse: Workshop via Steam's client protocol …` / `… via Workshop page reading …`; `steam-cm: …`.
- **Measured 2026-11-11** (isolated backend, every case 0 rule violations): first page 2.7 s (incl. the 1.4–1.5 s
  connect), later pages / filter changes / search / sorts 0.4–1.2 s, a prefetched page 0.4 s; fallback page 2.5 s
  (60 read → 36 kept for `[Everyone, Questionable, Video] −Girls`).

## Rules
- **A throwing endpoint still answers** (`ServerHost` middleware right after the security guard, `ApiSecurity.Guard` — which sets the dev origin's `Access-Control-Allow-Origin` before it; owner 2026-11-11: a Workshop download
  showed only "Download failed: Failed to fetch"): unhandled, Kestrel sent a bare 500 with the headers reset — CORS's
  `Access-Control-Allow-Origin` too — so the dev UI (Vite :5173, another origin) saw a network error, and with the loggers
  cleared nothing was written. Now: `error: <METHOD> <path>: <Type>: <message>` on stdout, and a JSON `{error}` 500
  (`SteamCooldownException` → 429) over the same response, which `jpost` shows word for word. A request the page abandoned
  (`OperationCanceledException` + `RequestAborted`) is dropped quietly. Check with `curl -i -H 'Origin: http://localhost:5173'`.
- Endpoints stay **thin** — push real logic into `AppOps`/`SteamOps`/existing helpers, not lambdas.
- `SettingsService.Load()` per request (no cached singleton) — daemons may have changed the file.
- Never bind a whole `AppSettings` from a request body — a partial body resets what it leaves out.
  Settings go through `SettingsService.Patch` (merge over what's saved); `/playlist/state` through `JsonMerge.Over`.
- **Every settings write is field-level**: `SettingsService.Update(s => s.Field = …)` (or `Patch`) — `Save` is
  private. Both run under `PatchLock` + `FileLock` (`settings.json.lock`, an `flock` shared with the CLI and the
  daemons). `/apply`, random, next/prev and a playlist play used to load the settings, switch, then save that
  whole copy for its `LastSession` — reverting a `/settings` change made meanwhile; the Steam sign-in did the
  same. A step (a volume key) is computed INSIDE the mutate from what's saved, never from an earlier load (16
  concurrent local volume-ups kept one; `scripts/test-cross-process.sh`).
- **`SettingsService.Save` is atomic** (a per-writer temp file renamed over `settings.json`) and `Load`
  retries a file it can't parse. It used to truncate + write in place: a load mid-write got the C#
  defaults (NoAudio on, volume 100, the legacy engine), applied them live, and the next save wrote them
  back over everything — `/settings`'s own `prev` included (an engine "switch", the Steam tokens gone).
  Never write a shared state file in place; guard: the matrix's `race:settingsSaveLoad` cell. The same holds
  for `playlist_state.json` / saved playlists (`PlaylistService`) and every library `index.json`
  (`LibraryStore.SaveIndex`): `AtomicFile.WriteAllText` (temp + rename) + `AtomicFile.ReadJson` (retries a
  torn file) — written in place, a read mid-save got a null playlist (the UI's init then held the DEFAULT
  playlist settings) or an empty index (every override "follows the global"); guards
  `race:playlistSaveLoad` / `race:indexSaveLoad`.
- Never break a CLI flag / daemon / state-file format (`session.md`, `player.md`, `library.md`).
