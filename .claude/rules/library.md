---
paths:
  - "src/livepaper/Helpers/LibraryService.cs"
  - "src/livepaper/Helpers/DownloadHelper.cs"
  - "src/livepaper/Models/LibraryItem.cs"
---

## File Naming & Library

Library storage: `~/.local/share/livepaper/library/`
Each entry: `{Title}.mp4` + `{Title}.jpg` (thumbnail) + `{Title}.id` (source URL for dedup).

The `.id` sidecar contains the source page URL. On download, if a wallpaper with the same source URL already exists, the download is skipped and the existing file applied.

Config: `~/.config/livepaper/settings.json` — Cache: `~/.cache/livepaper/`

### Sidecar files (all share the video/scene base name)

| Extension | Purpose |
|---|---|
| `.id` | Source URL or workshop ID |
| `.volume` | Per-video volume override (int, 0–100) |
| `.speed` | Per-video speed override (double, InvariantCulture) |
| `.crashed` | Empty file — scene crashed; card shows warning |
| `.whitelist` | Empty file — scene stays in playlist even if crashed |
| `.scene` | Library scene entry; content = workshop ID (numeric) OR full path to copied dir when `WeCopyFiles=true` |

### Scene copying (`WeCopyFiles=true`)

`LibraryItem.CopiedSceneDir` is non-null when the scene's workshop directory was copied into the library. `DownloadHelper` copies the full dir and writes its path into `.scene`. `LibraryService.LoadAll` detects this via `Path.IsPathRooted` on the `.scene` content; the numeric workshop ID is then recovered from the `.id` sidecar via `ParseWorkshopId`. Trash, RestoreBatch, and Delete all move/restore/delete `CopiedSceneDir` alongside `.scene`.

Videos with `WeCopyFiles=true` are copied (not symlinked). Videos without it use `File.CreateSymbolicLink`.

### WE dedup index (`we_ids.txt`)

`we_ids.txt` at library root — one workshop ID per line. Used by `SyncWallpaperEngine` as a single-read dedup check instead of reading N `.id` sidecars.

- **Bootstrap**: if file missing, built from existing `.id` sidecars (one-time migration).
- **Append-on-import**: after each successful WE import, `AppendToWeIndex(workshopId)` appends one line.
- **Rebuild-on-delete**: `Delete()`, `Trash()`, `RestoreBatch()` call `RebuildWeIndex()` to keep index accurate.
- **Corruption safety**: if read fails, falls back to scanning `.id` sidecars directly.

### Soft delete

Moves all sidecars to `.trash/<batchId>/`. Trash purged on window close or startup. **Ctrl+Z** restores last batch.

### File paths beyond library

- `~/.config/livepaper/lwe.pid` — PIDs of running LWE processes
- `~/.config/livepaper/user_mute.state` — presence = user muted (guards against auto-unmute)
- `~/.cache/livepaper/playlist_observer_paths.json` — shuffled path order for playlist observer reconnection
- `~/.cache/livepaper/we_thumbs/<workshopId>.jpg` — static frame extracted from GIF thumbnails
- `~/.config/livepaper/workshop_unsub.json` — durable "Delete from Source" unsubscribe queue (below)

## Delete vs Delete from Source (workshop items)

- **Delete** (`DeleteCards`): soft-delete to `.trash/`, undoable. **Keeps** the Steam subscription — only removes the local entry. `PurgeBatch` does NOT unsubscribe. **Exception:** when `AutoImportWallpaperEngine` is on, a plain delete of a workshop item would be re-imported next launch, so `DeleteCards` enqueues the unsubscribe (= delete-from-source) for any item with a `WorkshopId`.
- **Delete from Source** (`WallpaperCardViewModel.DeleteFromSource`, right-click): enqueues the workshop id + soft-deletes the entry. Applies to any workshop item — symlink OR copy (`IsWorkshopItem` = `WorkshopId != null`); the drain works by id. Right-click option hidden when auto-import is on (`ShowDeleteFromSource = IsWorkshopItem && !AutoImportActive`) — the trash button already does it. Cards get `AutoImportActive` at creation + on `OnAutoImportWallpaperEngineChanged`.

**We never delete the workshop folder ourselves.** Unsubscribing makes Steam remove the folder + its `appworkshop_431960.acf` entry together on its next sync (consistent — self-deleting would leave a stale acf/folder mismatch and touch Steam's files). A `blocked` set keeps AutoImport from resurrecting the lingering folder until Steam cleans it.

### `WorkshopUnsubQueue` (`Helpers/WorkshopUnsubQueue.cs`)
- Persisted JSON at `~/.config/livepaper/workshop_unsub.json`: `{ Pending[], Blocked[] }`.
- `pending` — enqueued, awaiting the unsubscribe POST. `blocked` — unsubscribed; AutoImport skips while Steam's folder cleanup lags.
- API: `AddPending`, `RemovePending` (undo), `MarkBlocked` (drain success: pending→blocked), `Unblock` (re-subscribe / WE-Local re-add: drop from both), `SnapshotPending`, `HasPending`, `SnapshotBlockedSet` (one read for a whole pass), `PruneBlocked(folderExists)`. Thread-safe (re-reads file under a lock per call).
- **AutoImport** (`SyncWallpaperEngine`) snapshots `pending ∪ blocked` **once** into a `HashSet` and skips matches in the loop (never `IsBlocked` per folder — that would re-read the file per dir).
- **Undo** of delete-from-source → `RemovePending(ids)` (no unsubscribe ran). No-op for plain deletes.
- **Re-add** (re-subscribe via `AcquireViaSubscribeAsync`, or WE-Local re-download in `DownloadOneAsync`) → `Unblock(id)`.

### Drain (`WorkshopDownloader.DrainUnsubQueueAsync`)
- Per id: `SetSubscribedAsync(subscribe:false)` → `MarkBlocked(id)`. **No folder delete** — Steam does it. Throttled 300ms (rate-limit). Unsubscribe failure leaves the id pending to retry.
- **Prune** (`WorkshopDownloader.PruneBlocked`, launch, background): drops blocked ids whose folder is gone (Steam finished). `WorkshopContentRoots` parses `libraryfolders.vdf` **once** and reuses it across ids (don't re-parse per id).
- **One drain task at a time** (VM `_draining` Interlocked guard). The modal (`IsUnsubModalOpen`) is a *view* onto it — **Dismiss hides the modal but does NOT stop the drain**; progress keeps flowing to `StatusMessage`.
- **Launch**: prune, then `DrainUnsubInBackground` resumes a leftover queue (dismissable modal + status bar).
- **Close**: `MainWindow.OnClosing` → `Vm.BeginCloseDrain(closeNow)`; if queued it cancels the close, runs the drain, completion callback calls `Close()` (`_allowClose` guards re-entry). Force-quit mid-drain → queue persists → resumes next launch.
