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
  reorder/rotation of a running timed playlist — trash/undo go through it too — and a change of its
  transitions re-arms an aligned switch already armed for A's end, `PlayerHelper.RearmAlignedSwitch`:
  under lp-player that switch was requested with the old effect/duration; `/settings` does the same for
  the global transitions and `TransitionMethod`), `RunAction` (keybinds).
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
- **Removing the playing item from the strip** (X / context menu → `/playlist/state` without it): it keeps
  playing, and the rotation goes on from **its place** — the first item after it in the previous list
  that's still there (`ReorderPlaylist(…, previousPaths)`; like Trash). It went on from the top of the new
  list (removing item 5 of 10 replayed 1–4). Only for an edit of the same list (nothing added): a
  different playlist loaded over it starts at its own top.
- **`Web/SteamOps.cs`** — QR login (→ WS `steam-qr` PNG via QRCoder, `steam-signed-in`), status
  (daysLeft), signout, unsub drain (→ WS `unsub-progress`, Interlocked one-at-a-time).

## Endpoints (all under `http://127.0.0.1:<port>`)
`GET /health /sources /settings /themes /mpv-preview /player-engine /library /current /workshop/queue /steam/status
/playlist/state /playlist/names /library/undo-depth /library/duration`,
`POST /browse /detail /settings /apply /stop /action /next /prev /random /pause /volume /mute /download /open
/preview /library/{delete,clear,volume,speed,whitelist,sync,import,trash,undo} /playlist/{state,save,load,play,play-from}
/steam/{qr/start,qr/cancel,signout} /workshop/{delete-from-source,drain}`, `GET /img?u=&r=` (proxy,
Firefox UA + Referer for moewalls), `GET /media?path=`, WS `/events`.

**Live-apply:** `/library/volume|speed` save the override (dropped when == global) then `PlayerHelper.ApplyOverrideLive` retargets the *playing* wallpaper instantly (mpv IPC / `pactl` for scenes). `/preview` is the throttled drag-preview twin — sets mpv/LWE volume|speed NOW with **no persist** (the modal throttles it during a slider drag, then persists once on release). **`/preview {volume|speed, global:true}`** is the Settings page's global sliders' twin (`PlayerHelper.PreviewGlobal`): every live wallpaper WITHOUT its own override for that field takes the dragged value (override ?? global, R61 — an overridden one never moves); lp-player: one `set` per following source from the cached source map; legacy: the current item when it has no override. **A no-op `/settings` costs ~5–10 ms** (300-item library, `scripts/test-settings-latency.sh`): it used to be 0.15–0.5 s because `_ = LibraryService.BackfillLoudnessAsync()` ran the whole library scan synchronously on the request thread (an `async` method runs until its first real await — with every item measured, that was all of it) and parsed `index.json` twice per item; now `KickLoudnessBackfill(force: just switched on)` runs it on the thread pool, at most once per 30 s otherwise, reading each index once. The handler logs its phases when it takes > 100 ms (`/settings: N ms (load+save …, backfill …)`; always with `LP_PROFILE_SETTINGS=1`). `/settings` applies the *effective* (`override ?? global`) value so a global change never clobbers an active override — and so does the volume keybind (`PlayerHelper.AdjustVolume`: `--action=volume-up|down`, `/volume {delta}`), the keyboard twin of the global slider: it moves the GLOBAL and pushes the playing item's effective volume (it pushed the new global onto an item with its own volume, which then jumped off its override until the next settings save snapped it back; matrix `cli:volume-up|down:overridden`). Normalization is applied to every live source by its own item, and again the moment a background loudness measurement lands (`PlayerHelper.OnLoudnessMeasured`) — an item that started unmeasured used to play un-normalized until its next switch. It also live-applies `VideoScale` (mpv `panscan`). A `PlayerEngine` change in `/settings` switches the engine live (`PlayerHelper.SwitchEngineLive` — see `player-adapter.md`); under lp-player `/preview` targets the playing item's own source. `/open` reveals an item in the file manager (resolves the symlink / scene dir). `/library/duration` = ffprobe.

## WS event types
`wallpaper-changed {path}` (every switch — `SwitchToFile`; `null` on a keybind stop / trash stop) `· settings-changed
{…changed fields}` (the backend changed settings itself — a keybind volume-up/down; the UI merges it:
every UI save posts its WHOLE copy, so a stale one reverted the keybind's volume) `· scene-crashed {path} · timed-stopped · download-progress {id,value,done?,status?}
· unsub-progress {done,total,currentId,finished?} · library-synced {count} · steam-qr {png}
· steam-signed-in {…status} · steam-qr-error {message}`.

## Rules
- Endpoints stay **thin** — push real logic into `AppOps`/`SteamOps`/existing helpers, not lambdas.
- `SettingsService.Load()` per request (no cached singleton) — daemons may have changed the file.
- **`SettingsService.Save` is atomic** (a per-writer temp file renamed over `settings.json`) and `Load`
  retries a file it can't parse. It used to truncate + write in place: a load mid-write got the C#
  defaults (NoAudio on, volume 100, the legacy engine), applied them live, and the next save wrote them
  back over everything — `/settings`'s own `prev` included (an engine "switch", the Steam tokens gone).
  Never write a shared state file in place; guard: the matrix's `race:settingsSaveLoad` cell.
- Never break a CLI flag / daemon / state-file format (`session.md`, `player.md`, `library.md`).
