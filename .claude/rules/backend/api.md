---
paths:
  - "src/backend/Web/ServerHost.cs"
  - "src/backend/Web/ApiSecurity.cs"
  - "src/backend/Web/AppOps.cs"
  - "src/backend/Web/EventBus.cs"
  - "src/backend/Web/ActionForward.cs"
  - "src/backend/Web/SceneLoudnessOps.cs"
  - "src/backend/Helpers/FeatureHealth.cs"
  - "src/backend/Program.cs"
---

# Backend web API (`liascape-backend serve`)

`Web/` wraps the scrapers, helpers and daemons for the Electron/React UI. Kestrel binds a free `127.0.0.1` port P (or
`LIASCAPE_PORT`) for the API and P + 1 for media (`ApiSecurity.PickPorts`), writes `serve.token` then `serve.port` (P) to `~/.config/liascape/`. Endpoint list: read
`ServerHost.cs`. Why behind the choices here: `docs/decisions.md` § Backend/API.

## Security (`Web/ApiSecurity.cs`, the first middleware)
- Every request presents the token: header `X-Liascape-Token`, or `?token=` on a GET/HEAD only (img/video src, the WebSocket). Writes use the header. Exempt: `GET /health` and the static UI files.
- Write the token file 0600 (temp + rename) BEFORE `serve.port`; reuse a valid one across restarts so an open page keeps working. It stays beside `serve.port`, not in `$XDG_RUNTIME_DIR` (hermetic tests keep the session's runtime dir).
- `Host` must be `127.0.0.1:<port>` or `localhost:<port>` of the listener it reached (DNS rebinding) → else 403.
- A foreign `Origin` → 403. Allowed: the Vite dev origins only while this backend serves no UI (`LIASCAPE_UI_DIR` unset), plus `LIASCAPE_DEV_ORIGINS`. Never add `Access-Control-Allow-Origin: *` or `UseCors`.
- The media listener (P + 1) is its own origin with its own 6 browser connections, so slow media never queues an API call: it answers only token-carrying GETs of `/media` `/clip` `/img` `/anim` `/still` (anything else 404, no `/health`, no UI files, no WebSocket, no preflight). An `Origin` there must be the API's or an allowed dev origin, echoed back (the transition preview's `<video crossorigin>`); the media origin is foreign to the API. The API keeps serving the media routes for clients without the media port. Why: `docs/decisions.md` § "Serve media from a second listener". Guard: matrix `browse:mediaPool`.
- Local files (`/media`, `/clip`, `/anim`, `/still`, `/library/duration`, `/open` reveal, `/open/media`) only under the data dir, the caches and the `WorkshopFolder` (`ApiSecurity.MediaAllowed`); refuse `..`.
- Remote fetches (`/img`, remote `/anim` `/still`): http(s) only, every resolved address public, checked again at connect (`PublicOnlyHttp`). No proxy.
- `POST /open`: http(s) URLs, or `{path, reveal: true}` under `MediaAllowed`. Never a bare path, `file:` or a custom scheme; `steam://` only via `POST /steam/open-page` with a digits-only id.
- `POST /open/media {path}` (the sidebar preview in the user's own app) opens only what `ApiSecurity.OpenableMedia` passes: a video (`.mp4 .webm .mkv .mov .m4v .avi`) or a picture (`.png .jpg .jpeg .webp .gif`) by name, under `MediaAllowed`, its `realpath` re-checked against the roots' own realpaths (the resolved name in the same family), a regular file (opened `O_NONBLOCK`) whose first bytes are that family's (a video container's; a PNG / JPEG / WebP / GIF header) with no `[Desktop` group in its first 4 KiB; `xdg-open` gets that resolved path as its one argument. Anything else 403 — xdg-open runs a file it takes for a `.desktop`. Guard: `scripts/test-item-actions.sh`.
- Spawn processes with an argument list (`ArgumentList`), never by pasting values into an `sh -c` string or one command string.
- Serve `/media` `/clip` `/img` `/anim` `/still`, and every answer of the media listener, with `Content-Security-Policy: sandbox; default-src 'none'`.
- Check after a security change: a private backend + curl — no token → 401, wrong `Host` → 403, foreign `Origin` → 403, `/media` outside → 403, `/img` to 127.0.0.1 / 192.168.x / 169.254.169.254 / `[::1]` → 403; on the media port an API route → 404, and on the API the media origin as `Origin` → 403.

## Endpoint conventions
- Keep endpoints thin: logic goes in `AppOps` / `SteamOps` / helpers, not lambdas.
- A throwing endpoint still answers: the middleware after the guard logs `error: <METHOD> <path>: …` and returns JSON `{error}` 500 (`SteamCooldownException` → 429), keeping the CORS header. Drop an aborted request quietly.
- `SettingsService.Load()` per request; never cache settings (daemons and the CLI write the file).
- Never bind a whole `AppSettings` from a body: `POST /settings` is PATCH (`SettingsService.Patch`), `/playlist/state` merges (`JsonMerge.Over`). A bad value → 400 that saves nothing. `LastSession` and the Steam sign-in fields keep their saved values whatever the body says. Guard: `scripts/test-settings-merge.sh`.
- `/settings` applies the EFFECTIVE value (`override ?? global`) live, through `PlayerHelper.ApplyEffectiveLive` under liascape-player. A new setting must get its live path too.
- `POST /cache/clear {ids}` deletes only the regular files directly in each named category's folder (`AppOps.CacheCategories`, the folder its writer uses), never a symlink, a subfolder, a folder that is a link or a writer's file in progress (`Busy`); an unknown or empty id list → 400 that deletes nothing. Guard: `scripts/test-cache-clear.sh`.
- A no-op `/settings` must stay cheap: run library-wide work off the request thread (`KickLoudnessBackfill`). Guard: `scripts/test-settings-latency.sh`.
- `/next` `/prev` `/random` with nothing playable → 409 `{error}`, never 500.
- The volume keys move what `VolumeKeyTarget` says (`auto` / `item` / `global`); an item change broadcasts `library-item-changed`, a global one `settings-changed`.

## Session and playlist operations (`AppOps`)
- `PlayFrom` persists the playlist bar in its own order, not the play order.
- Removing the playing item from the bar keeps it playing; the rotation goes on from its place (`ReorderPlaylist(…, previousPaths)`).
- Trash removes the items from the playlist too; Undo puts each back at its index. If one was on screen or incoming (`LiascapePlayerMedia.ShownOrIncomingPaths`) a playlist plays on from the next surviving item, a single wallpaper stops.
- A playlist's transition change re-arms an already-armed aligned switch (`PlayerHelper.RearmAlignedSwitch`).

## CLI forwarding (`Web/ActionForward.cs`)
- `liascape <action>` goes to a running backend (`serve.port` → `GET /health` → `POST /action` with the token), runs locally only when no backend answers `/health`, and never falls back once the POST was sent.

## WebSocket events (`Web/EventBus.cs`, `/events`)
- Serialize sends per socket (concurrent `SendAsync` throws).
- Stopping closes every socket from our side (1001, through its send gate; cut after 1 s) and `HostOptions.ShutdownTimeout` (2 s) cuts any other open request: an open page never closes first, and Kestrel's graceful stop otherwise waits 30 s for it, past a service manager's stop timeout. Guard: `scripts/test-backend-stop.sh`.
- The event list is `grep -rho 'Broadcast("[a-z-]*"' src/backend`; the UI handles them in `app/ui/src/store/`. Reuse an existing event before adding one.
- `library-item-changed` and `settings-changed` carry only the changed fields; the UI merges them (every UI save posts its whole copy, so a missed merge reverts a backend change).
- `wallpaper-changed` is the only source of "what plays" for the UI (sent at B's effect start).
- A page re-reads everything on WS reopen (`store.resync()`); never rely on `library-synced` reaching an open page.

## Feature health (`GET /health/features`, `Helpers/FeatureHealth.cs`)
- Report every dependency that silently degrades a feature: `{id, label, ok (true|false|null), reason, affects (camelCase settings keys), inUse}`. Never spawn a player for it (the running player's `hello.health`, else `liascape-player health`, cached 30 s).
- Keep `Build(Inputs)` pure. Guards: self-test `FeatureHealthAssertions`, `--probe probe-health.js`.

## Scene loudness queue (`Web/SceneLoudnessOps.cs` + `Helpers/SceneLoudnessPlanner.cs`)
- One background `liascape-player scene-loudness` child at a time under `nice -n 19 ionice -c3`, `LD_LIBRARY_PATH` dropped, 600 s bound, never on a request thread, never touching playback.
- Store a result atomically (`SetMeta`) only when its child succeeded; cancel kills the child and drops the queue.
