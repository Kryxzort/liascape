---
paths:
  - "src/livepaper/Web/**"
  - "src/livepaper/Program.cs"
---

# Web backend (`--serve`)

The C# app gained a headless web backend for the Electron/React UI. **All scrapers, helpers,
services, models, CLI flags and daemons are unchanged** — `Web/` only wraps them.

## Entry
`Program.cs` `--serve` branch → `Web/ServerHost.Run`. Kestrel binds **127.0.0.1:0** (random free
port), writes it to `~/.config/livepaper/serve.port` (Electron reads it). Loopback-only.
All other CLI flags (`--restore/--random/--kill/--monitor/--timer-daemon/--restart-daemon/--action=*`)
and the daemons are **untouched** — do not change their behavior.

## Files
- **`Web/ServerHost.cs`** — minimal-API endpoints (thin wrappers), CORS (for `vite dev`), static
  serving of the built UI when `LP_UI_DIR` is set (→ same-origin, UI uses relative paths), image
  proxy, `/media`, WebSocket `/events`. Providers array order == the UI source-pill order; WE-local
  (index 3) `available:false` when `AutoImportWallpaperEngine`.
- **`Web/EventBus.cs`** — WS broadcaster. **Replaces PlayerHelper's `Action?` callbacks**
  (`OnWallpaperChanged`/`OnSceneCrashed`/`OnTimedPlaylistStopped`) — wired in `WirePlayer()`. Per-socket
  send is serialized (concurrent `SendAsync` on one socket throws).
- **`Web/AppOps.cs`** — backend orchestration: `PlayPlaylist`/`PlayFrom`
  (effective-settings: override-global vs global), `DownloadAsync` (web + workshop-acquire), `Trash`
  (+ delete-stops/advances-playback), `Undo` (in-memory batch stack), `DeleteFromSource`.
- **`Web/SteamOps.cs`** — QR login (→ WS `steam-qr` PNG via QRCoder, `steam-signed-in`), status
  (daysLeft), signout, unsub drain (→ WS `unsub-progress`, Interlocked one-at-a-time).

## Endpoints (all under `http://127.0.0.1:<port>`)
`GET /health /sources /settings /themes /mpv-preview /library /current /workshop/queue /steam/status
/playlist/state /playlist/names /library/undo-depth /library/duration`,
`POST /browse /detail /settings /apply /stop /next /prev /random /pause /volume /mute /download /open
/preview /library/{delete,clear,volume,speed,whitelist,sync,import,trash,undo} /playlist/{state,save,load,play,play-from}
/steam/{qr/start,qr/cancel,signout} /workshop/{delete-from-source,drain}`, `GET /img?u=&r=` (proxy,
Firefox UA + Referer for moewalls), `GET /media?path=`, WS `/events`.

**Live-apply:** `/library/volume|speed` save the override (dropped when == global) then `PlayerHelper.ApplyOverrideLive` retargets the *playing* wallpaper instantly (mpv IPC / `pactl` for scenes). `/preview` is the throttled drag-preview twin — sets mpv/LWE volume|speed NOW with **no persist** (the modal throttles it during a slider drag, then persists once on release). `/settings` applies the *effective* (`override ?? global`) value so a global change never clobbers an active override; it also live-applies `VideoScale` (mpv `panscan`). `/open` reveals an item in the file manager (resolves the symlink / scene dir). `/library/duration` = ffprobe.

## WS event types
`wallpaper-changed {path} · scene-crashed {path} · timed-stopped · download-progress {id,value,done?,status?}
· unsub-progress {done,total,currentId,finished?} · library-synced {count} · steam-qr {png}
· steam-signed-in {…status} · steam-qr-error {message}`.

## Rules
- Endpoints stay **thin** — push real logic into `AppOps`/`SteamOps`/existing helpers, not lambdas.
- `SettingsService.Load()` per request (no cached singleton) — daemons may have changed the file.
- Never break a CLI flag / daemon / state-file format (`session.md`, `player.md`, `library.md`).
