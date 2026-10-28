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
it to `~/.config/liascape/serve.port` (Electron reads it). Loopback-only.
All other subcommands (`restore`, `random`, `kill`, the keybind actions, the internal `monitor-daemon`/`timer-daemon`/`restart-daemon`)
and the daemons keep their behavior. **`liascape <action>` is handed to a running backend**
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
  playlist session plays on from the **next surviving playlist bar item after it** (`PlayFrom`, wrapping), a
  single one stops. The UI drops the items from its playlist bar before the request and re-reads
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
- **`Web/SteamOps.cs`** — QR login (→ WS `steam-qr` PNG via QRCoder, `steam-signed-in`), status
  (daysLeft), signout, unsub drain (→ WS `unsub-progress`, Interlocked one-at-a-time).

## Endpoints (all under `http://127.0.0.1:<port>`)
`GET /health /health/features /sources /settings /themes /mpv-preview /player-engine /library /current /workshop/queue /steam/status
/playlist/state /playlist/names /library/undo-depth /library/duration /library/scene-props?path=`,
`POST /browse /detail /settings /apply /stop /action /next /prev /random /pause /volume /mute /download /open
/preview /library/{delete,clear,volume,speed,whitelist,sync,import,trash,undo,scene-props,scene-props/preview} /playlist/{state,save,load,play,play-from}
/steam/{qr/start,qr/cancel,signout} /workshop/{delete-from-source,drain}`, `GET /img?u=&r=` (proxy,
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

**Live-apply:** `/library/volume|speed` save the override (dropped when == global) then `PlayerHelper.ApplyOverrideLive` retargets the *playing* wallpaper instantly (mpv IPC / `pactl` for scenes). `/preview` is the throttled drag-preview twin — sets mpv/LWE volume|speed NOW with **no persist** (the modal throttles it during a slider drag, then persists once on release). **`/preview {volume|speed, global:true}`** is the Settings page's global sliders' twin (`PlayerHelper.PreviewGlobal`): every live wallpaper WITHOUT its own override for that field takes the dragged value (override ?? global, R61 — an overridden one never moves); liascape-player: one `set` per following source from the cached source map; legacy: the current item when it has no override. **A no-op `/settings` costs ~5–10 ms** (300-item library, `scripts/test-settings-latency.sh`): it used to be 0.15–0.5 s because `_ = LibraryService.BackfillLoudnessAsync()` ran the whole library scan synchronously on the request thread (an `async` method runs until its first real await — with every item measured, that was all of it) and parsed `index.json` twice per item; now `KickLoudnessBackfill(force: just switched on)` runs it on the thread pool, at most once per 30 s otherwise, reading each index once. The handler logs its phases when it takes > 100 ms (`/settings: N ms (load+save …, backfill …)`; always with `LIASCAPE_PROFILE_SETTINGS=1`). `/settings` applies the *effective* (`override ?? global`) value so a global change never clobbers an active override — and the volume keybinds (`AppOps.VolumeKey` → `PlayerHelper.AdjustVolume`: `liascape volume up|down`, `/volume {delta}`) move what **`VolumeKeyTarget`** (Advanced → "Volume keys adjust") says: `auto` (default) the playing wallpaper's own volume when it has one, else the global; `item` always the playing wallpaper's own (giving it one); `global` always the global — an overridden wallpaper then keeps its own (it used to get the new global pushed and snap back on the next settings save). An item change saves + live-applies like `/library/volume` and broadcasts WS `library-item-changed {path, volumeOverride}` (the grid and an open settings modal take it); a global one goes through `SettingsService.Update` (the `/settings` lock) and broadcasts `settings-changed {volume}`. Matrix `cli:volume-up|down:overridden|item|global`, `cli:volume-up:modalOpen`. Normalization is applied to every live source by its own item, and again the moment a background loudness measurement lands (`PlayerHelper.OnLoudnessMeasured`) — an item that started unmeasured used to play un-normalized until its next switch. Under liascape-player a WE scene is normalized too: the player learns its loudness on first play (`scene.loudness` → the index → its source's `gain.normalize`, ramped; `player-adapter.md` § Scenes → "Loudness"). It also live-applies `VideoScale` (mpv `panscan`). The rotation (interval — the minimum play time under advance-on-end —, advance-on-end, `GlobalMaxPlaySeconds`; a playlist's own via `/playlist/state`) applies live to the running rotation (`PlayerHelper.ApplyRotationLive` / `ApplyMaxPlayLive`, the effective values, diffed — `player-adapter.md` § Rotation). A `PlayerEngine` change in `/settings` switches the engine live (`PlayerHelper.SwitchEngineLive` — see `player-adapter.md`). Under liascape-player a `SceneMonitors` change applies live too (`LiascapePlayerMedia.ApplySceneFps` — each monitor's fps → `out:<name>.scene_fps`, diffed; legacy: launch-only, LWE can't reconfigure), and `GET /player-engine` carries `scenes {available, reason, assets_dir}` (can a scene play now, and why not — `player-adapter.md` § Scenes) and `vram {low_active, mode}` (the player's low-VRAM hold). The GPU / VRAM settings (`AutoThrottleScenes`, `LimitVramPerScene` + `SceneVramLimitMib`, `VramLowMode`) apply live too (`LiascapePlayerMedia.ApplyGpuSettings` → `player.scene_throttle` / `scene_vram_limit_mib` / `vram_low_mode`, diffed; `player-adapter.md` § Scenes). Under liascape-player every live-apply above — `/settings` (one pass for all of it), `/library/volume|speed`, `/preview`, the volume keys, normalization, mute — is a pass of ONE effective-settings resolver: each live source (either side of an effect, a pending B) gets its own item's value, diffed against what it runs (`player-adapter.md` § Targeting). `/open` reveals an item in the file manager (resolves the symlink / scene dir). `/library/duration` = ffprobe.
**Scene properties** (`AppOps.SceneProps/SetSceneProp/PreviewSceneProp`; library.md § "Scene properties"):
`GET /library/scene-props?path=<scene folder>` → `{path, engine, live, note, props: [{name, type, label, order,
condition, visible, editable, unsupported, default, value, overridden, min, max, step, fraction, precision, options}]}`
(display order; `value` = override ?? default; `visible` = its condition over the effective values; `live` false +
`note` under legacy — LWE takes them at launch only). `POST /library/scene-props {path, name, value}` saves one
(field-level, the index lock; == default → dropped), `{path, name, reset: true}` resets one, `{path, reset: true}` all
— then live on the item's source(s) (`PlayerHelper.ApplyScenePropsLive`) — and answers the new list; a bad value / an
unknown name / a non-editable type / not a scene folder → **400 `{error}`**, nothing saved. `POST
/library/scene-props/preview {path, name, value}` = the drag twin (live, nothing saved).

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
| `auto-mute` | `pactl` + `parec` | auto-mute can't hear other apps | `autoMute` |
| `mpris` | `playerctl` | "Only if MPRIS player active" never sees a player | `autoMuteOnlyIfMprisActive` |
| `ffmpeg` | `ffmpeg` + `ffprobe` | no loudness measurement, imports / thumbnails / durations fail | `normalizeAudio` |
| `steamcmd` | steamcmd (`WorkshopDownloader.FindSteamCmd`) | "Download via steamcmd" can't download | `workshopDownloadMode`, `steamCmdPath` |

Not listed (checked, no silent degradation to report): `wl-copy` (the UI copies with `navigator.clipboard`, no
`wl-copy` call exists), `grim` / `mpvpaper` (legacy only — the owner runs liascape-player), the PipeWire audio bus (down → the
sources play on mpv's default device; nothing stops working). Guards: `--probe probe-health.js` (matrix stack; RED on
the base UI), the adapter IT's `LIASCAPE_SCENE_WORKER_BIN=/nonexistent` section (`hello.health` + the endpoint).

## WS event types
`wallpaper-changed {path}` (every switch — `SwitchToFile`; `null` on a keybind stop / trash stop) `· settings-changed
{…changed fields}` (the backend changed settings itself — a keybind volume-up/down; the UI merges it:
every UI save posts its WHOLE copy, so a stale one reverted the keybind's volume) `· scene-crashed {path}` (legacy: an LWE process died; liascape-player: the scene's `source.broken` — the item is then marked crashed in its index; the UI marks its card at once) `· scene-vram-stopped {path, usedMib, limitMib, message}` (liascape-player: the VRAM guard stopped a scene — not a crash; the UI's status bar shows the message) `· timed-stopped · download-progress {id,value,done?,status?}
· unsub-progress {done,total,currentId,finished?} · library-synced {count} (the startup one fires before any open page has
reconnected — a page re-reads everything on a WS reopen instead: `web-ui.md` → "Backend restart under an open page") · library-item-changed {path, volumeOverride} (a volume keybind moved an item's own volume) · steam-qr {png}
· steam-signed-in {…status} · steam-qr-error {message}`.

## Rules
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
