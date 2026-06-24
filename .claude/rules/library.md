---
paths:
  - "src/livepaper/Helpers/LibraryService.cs"
  - "src/livepaper/Helpers/LibraryStore.cs"
  - "src/livepaper/Helpers/DownloadHelper.cs"
  - "src/livepaper/Helpers/ImportService.cs"
  - "src/livepaper/Models/LibraryItem.cs"
---

## Library layout (per-item folders + per-source `index.json`)

Library root: `~/.local/share/livepaper/library/`. Config: `~/.config/livepaper/settings.json` — Cache: `~/.cache/livepaper/`.

**Every item is its own folder, named after the item.** All metadata, per-item overrides, and dedup keys live in a per-source `index.json`.

```text
library/
  motionbgs/<name>/   <name>.mp4  <name>.jpg  [<name>.gif|webp]   web source; folder named after the wallpaper
  moewalls/<name>/    …
  desktophut/<name>/  …
  imported/<name>/    <name>.mp4|png  <name>.jpg                  local file imports
  workshop/<id>/      file.mp4|scene.pkg  preview.*  project.json  DIRECT steamcmd download (owned, full Steam folder)
  local/<id>          -> symlink into the user's WE dir            subscribed / WE-local (auto-import)
  <source>/index.json                                              per-source metadata (below)
  .trash/<batchId>/<source>/<key>/ + <key>.meta.json               soft delete
```

- `LoadAll` walks each source dir; **each child folder is one item**. Media resolved inside: `<key>.<videoext>|png` (web/imported), or `project.json`'s `"file"` / first video file (workshop/local). Identity = the folder name (no `.id`).
- **`local/<id>` is a symlink** into the WE dir (only the WE/Steam dir holds the bytes). **`workshop/<id>` is an owned copy** (full steamcmd folder). Web/imported hold the real file (symlink to the source for local imports unless `copyLocalFiles`, else downloaded).

## `LibraryStore` (`Helpers/LibraryStore.cs`) — the index

One `index.json` per source folder, keyed by `<key>` (`<id>` for workshop/local, `<name>` for web/imported). One `LibMeta` per item:

```
SourceUrl, Title, IsScene, WorkshopId, Volume?, Speed?, Crashed, Whitelist,
Resolution, AgeRating, YoutubeUrl, PageUrl, AuthorName, Description,
FileSizeBytes?, Subscriptions?, Favorites?, Views?, Tags[]
```

- Serialized `WhenWritingNull` → **absent `volume`/`speed` means "use global."**
- `Locate(mediaPath) → (source, key)`: splits the path relative to the library root — `parts[0]` = source, `parts[1]` = key. Works for a media file (`…/<source>/<key>/<file>`) **and** a scene folder (`…/<source>/<key>`).
- `GetMeta` / `SetMeta(path, mutate)` (lock-guarded read-modify-write, creates entry) / `Remove`. `LoadIndex` re-reads the file each call (no cache) — daemons/other writers may have changed it.

## Scenes are **folders**, not marker files

A scene's `VideoPath` **is its item folder** (`workshop/<id>` or `local/<id>`) — there is no `.scene` marker. `PlayerHelper.IsScenePath(path)` = "the path has no media file extension" (a folder ⟺ scene; a `.mp4`/`.png` ⟺ video/image). Scene-ness on load = index `IsScene`, else `project.json` `type:"scene"`, else a `scene.pkg` in the folder. LWE launches a **local** scene by **id** (its native WE-dir lookup) and an **owned** (`workshop/`) scene by **dir path**. `LibraryItem.CopiedSceneDir` = the owned folder (null for local). See `player.md`.

## Per-item volume/speed overrides (live)

- `LibraryService.ReadVolumeOverride/ReadSpeedOverride/IsWhitelisted/HasCrashed` → `LibraryStore.GetMeta(path)?.X`. **`PlayerHelper`'s private `ReadVolumeOverride/ReadSpeedOverride` delegate to these** — so *every* playback path (initial launch, playlist advance, transitions, scene launch, option baking) reads the same index.
- `SaveVolumeOverride/SaveSpeedOverride` **drop the key when it equals the global** (volume `== Settings.Volume`, speed within 1e-6) → "use global."
- **Live apply** (no restart): `POST /library/volume|speed` → save → `PlayerHelper.ApplyOverrideLive(path)` (mpv `set_property` for video volume/speed; `pactl` for live LWE **scene volume**; scenes are 1× so speed is a no-op). Timed-playlist advances carry the effective volume/speed as **`loadfile` per-file options** (atomic — avoids the post-load reset race). A global settings change applies the *effective* value (`override ?? global`) so it never clobbers an active override.

## Animated preview

The web UI animates library/strip cards from the source's **preview gif/webp** (not a transcode). It lives **inside the item folder** — `preview.gif`/`webp` (workshop/local) or `<key>.gif`/`webp` (web). `FindAnimated` resolves it → `LibraryItem.AnimatedThumbnailPath`; `DownloadHelper.SaveAnimatedPreviewAsync` persists an animated download URL (gif/webp/apng only). Items with no gif asset → the UI plays the local video on hover.

## Soft delete / trash / restore

- **Trash** moves the item **folder** to `.trash/<batchId>/<source>/<key>/`, writes a `<key>.meta.json` (`TrashedEntry` = source + key + isScene + the `LibMeta`), and removes the index key. Scene = the folder itself; video = its parent folder.
- **RestoreBatch** moves folders back + replays index entries. **Delete** removes the folder + index key.
- **Symlink safety:** `Directory.Delete(local/<id>, recursive:true)` on a **symlinked** dir *unlinks the symlink* — it does **not** touch the user's WE source files (verified on .NET 9). So deleting a `local/` item never destroys subscribed wallpapers.
- Trash purged on close/startup. **Ctrl+Z** restores the last batch (in-memory batch stack in `AppOps`).

## File paths beyond library

- `~/.config/livepaper/lwe.pid` — PIDs of running LWE processes
- `~/.config/livepaper/user_mute.state` — presence = user muted (guards auto-unmute)
- `~/.cache/livepaper/playlist_observer_paths.json` — shuffled order for playlist observer reconnection
- `~/.cache/livepaper/we_thumbs/<workshopId>.jpg` — static frame extracted from GIF thumbnails
- `~/.config/livepaper/serve.port` — the `--serve` backend's chosen port (Electron reads it)
- `~/.config/livepaper/workshop_unsub.json` — durable "Delete from Source" unsubscribe queue (below)

## Delete vs Delete from Source (workshop items)

Orchestrated in **`Web/AppOps.cs`**:

- **Delete** (`AppOps.Trash`): soft-delete to `.trash/`, undoable. **Keeps** the Steam subscription. **Exception:** when `AutoImportWallpaperEngine` is on, a plain delete of a workshop item would be re-imported next launch, so it enqueues the unsubscribe for any item with a `WorkshopId`.
- **Delete from Source** (`AppOps.DeleteFromSource`, `POST /workshop/delete-from-source`): enqueues the workshop id + soft-deletes. Applies to any workshop item — symlink OR copy (`WorkshopId != null`); the drain works by id. The UI hides this when auto-import is on (the trash button already does it).

**We never delete the workshop folder ourselves.** Unsubscribing makes Steam remove the folder + its `appworkshop_431960.acf` entry together on its next sync. A `blocked` set keeps AutoImport from resurrecting the lingering folder until Steam cleans it.

### `WorkshopUnsubQueue` (`Helpers/WorkshopUnsubQueue.cs`)
- Persisted JSON `~/.config/livepaper/workshop_unsub.json`: `{ Pending[], Blocked[] }`. `pending` = awaiting the unsubscribe POST; `blocked` = unsubscribed, AutoImport skips while Steam's cleanup lags.
- API: `AddPending`, `RemovePending` (undo), `MarkBlocked` (pending→blocked), `Unblock` (re-subscribe / WE-Local re-add: drop from both), `SnapshotPending`, `HasPending`, `SnapshotBlockedSet` (one read per pass), `PruneBlocked(folderExists)`. Thread-safe (re-reads under a lock per call).
- **AutoImport** (`SyncWallpaperEngine`) snapshots `pending ∪ blocked` once into a `HashSet` and skips matches (never `IsBlocked` per folder).

### Drain (`WorkshopDownloader.DrainUnsubQueueAsync`)
- Per id: `SetSubscribedAsync(subscribe:false)` → `MarkBlocked(id)`. **No folder delete** — Steam does it. Throttled 300ms; failure leaves the id pending. Aborts the rest on a 429 rate-limit.
- **Prune** (`PruneBlocked`, launch, background): drops blocked ids whose folder is gone; parses `libraryfolders.vdf` once and reuses across ids.
- **One drain at a time** (`SteamOps`, Interlocked guard). Progress → WS `unsub-progress`; the modal is a dismissable *view* (Dismiss hides it, the drain keeps running). Force-quit mid-drain → queue persists → resumes next launch.
