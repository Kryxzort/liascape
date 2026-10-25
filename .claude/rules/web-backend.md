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
port; `LP_PORT` pins it — the Electron shell passes the previous launch's port while it's free, since the
UI's origin IS that port and a new origin per launch reset every localStorage pref; dev pins 5174), writes
it to `~/.config/livepaper/serve.port` (Electron reads it). Loopback-only.
All other CLI flags (`--restore/--random/--kill/--monitor/--timer-daemon/--restart-daemon/--action=*`)
and the daemons keep their behavior. **`--action=<name>` is handed to a running backend**
(`Web/ActionForward`: `serve.port` → `GET /health` must answer `{ok:true}` → `POST /action {name}`), which
runs it on its own session state (`AppOps.RunAction` — the same switch the CLI runs) so the UI hears about
it: run in the one-shot process, a single-session next/prev/random switched the wallpaper behind the
backend's back (stale history, the UI kept marking the old one playing). It runs locally only when no
backend answers `/health`; once the POST is sent it never falls back (a doubled next skips one, a doubled
toggle undoes itself). Unknown action → exit 1 with the list. A keybind slower than 1.5 s prints its
phases to stderr (`slow — runtime start / init / forward`; unloaded the whole CLI is ~0.14 s — the UI
matrix saw 6–15 s only under the owner's desktop load, the forward itself < 1 s), and `/action` logs any
run over 500 ms.

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
  / `Undo` / `DeleteFromSource` (below), `SavePlaylistState` (`/playlist/state`'s body: save + live
  reorder/rotation of a running timed playlist — trash/undo go through it too), `RunAction` (keybinds).
- **Trash** (`AppOps.Trash`, old-app parity): the items leave the **playlist** too (live — a running
  rotation never plays a trashed file; an armed aligned switch to one is re-armed), the batch remembers
  each one's playlist index and **Undo puts it back there** (+ un-queues a delete-from-source
  unsubscribe). If one was **on screen or incoming** (lp-player: `LpPlayerMedia.ShownOrIncomingPaths` —
  every layer's content, an effect's `to`, every requested switch's B except an aligned one still waiting
  for A's end; `cur:*` alone missed a switch requested but not yet running; legacy: the current file), a
  playlist session plays on from the **next surviving strip item after it** (`PlayFrom`, wrapping), a
  single one stops. The UI drops the items from its strip before the request and re-reads
  `/playlist/state` after trash and undo (a stale strip saves itself back over the backend's).
- **`PlayFrom`** plays `[clicked, rest…]` but persists the strip in **its own order** (`persistPaths`) —
  persisting the play order reordered the strip on the next launch.
- **`Web/SteamOps.cs`** — QR login (→ WS `steam-qr` PNG via QRCoder, `steam-signed-in`), status
  (daysLeft), signout, unsub drain (→ WS `unsub-progress`, Interlocked one-at-a-time).

## Endpoints (all under `http://127.0.0.1:<port>`)
`GET /health /sources /settings /themes /mpv-preview /player-engine /library /current /workshop/queue /steam/status
/playlist/state /playlist/names /library/undo-depth /library/duration`,
`POST /browse /detail /settings /apply /stop /action /next /prev /random /pause /volume /mute /download /open
/preview /library/{delete,clear,volume,speed,whitelist,sync,import,trash,undo} /playlist/{state,save,load,play,play-from}
/steam/{qr/start,qr/cancel,signout} /workshop/{delete-from-source,drain}`, `GET /img?u=&r=` (proxy,
Firefox UA + Referer for moewalls), `GET /media?path=`, WS `/events`.

**Live-apply:** `/library/volume|speed` save the override (dropped when == global) then `PlayerHelper.ApplyOverrideLive` retargets the *playing* wallpaper instantly (mpv IPC / `pactl` for scenes). `/preview` is the throttled drag-preview twin — sets mpv/LWE volume|speed NOW with **no persist** (the modal throttles it during a slider drag, then persists once on release). `/settings` applies the *effective* (`override ?? global`) value so a global change never clobbers an active override; it also live-applies `VideoScale` (mpv `panscan`). A `PlayerEngine` change in `/settings` switches the engine live (`PlayerHelper.SwitchEngineLive` — see `player-adapter.md`); under lp-player `/preview` targets the playing item's own source. `/open` reveals an item in the file manager (resolves the symlink / scene dir). `/library/duration` = ffprobe.

## WS event types
`wallpaper-changed {path}` (every switch — `SwitchToFile`; `null` on a keybind stop / trash stop) `· settings-changed
{…changed fields}` (the backend changed settings itself — a keybind volume-up/down; the UI merges it:
every UI save posts its WHOLE copy, so a stale one reverted the keybind's volume) `· scene-crashed {path} · timed-stopped · download-progress {id,value,done?,status?}
· unsub-progress {done,total,currentId,finished?} · library-synced {count} · steam-qr {png}
· steam-signed-in {…status} · steam-qr-error {message}`.

## Rules
- Endpoints stay **thin** — push real logic into `AppOps`/`SteamOps`/existing helpers, not lambdas.
- `SettingsService.Load()` per request (no cached singleton) — daemons may have changed the file.
- Never break a CLI flag / daemon / state-file format (`session.md`, `player.md`, `library.md`).
