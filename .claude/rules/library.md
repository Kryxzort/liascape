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

- **Delete** (`DeleteCards`): soft-delete to `.trash/`, undoable. **Keeps** the Steam subscription — only removes the local entry. `PurgeBatch` does NOT unsubscribe.
- **Delete from Source** (`WallpaperCardViewModel.DeleteFromSource`, right-click, `IsWeSymlink` only): enqueues the workshop id into `WorkshopUnsubQueue` + soft-deletes the entry. The unsubscribe + folder delete happen later in a throttled drain — never inline (inline raced Steam's folder cleanup → quick restart + AutoImport re-imported the item; and a bulk 200-300 delete can't be a fire-and-forget burst at shutdown).

### `WorkshopUnsubQueue` (`Helpers/WorkshopUnsubQueue.cs`)
- Persisted JSON list at `~/.config/livepaper/workshop_unsub.json`. Holds **only ids not yet unsubscribed** — a successful drain step removes the id from the file immediately (no "done" set kept).
- `AddPending`, `Remove` (undo / re-subscribe / drain success), `IsBlocked`, `HasPending`, `Snapshot`. Thread-safe (re-reads file under a lock per call).
- **Undo** of a delete-from-source batch → `Remove(ids)` (no unsubscribe ran). No-op for plain deletes.
- **AutoImport** (`SyncWallpaperEngine`) skips `IsBlocked` ids → a still-on-disk folder isn't re-imported before the drain deletes it.
- **Re-subscribe** via `AcquireViaSubscribeAsync` success → `Remove(id)`.

### Drain (`WorkshopDownloader.DrainUnsubQueueAsync`)
- Per id: `SetSubscribedAsync(subscribe:false)` → `DeleteWorkshopFolders` (delete every on-disk copy across all Steam libraries + steamcmd cache — a delete, not a cross-device move, so cheap) → `Remove(id)`. Throttled 300ms. Unsubscribe failure leaves the id queued to retry. Reports `(Done, Total, CurrentId)`.
- **One drain task at a time** (VM `_draining` Interlocked guard). The modal (`IsUnsubModalOpen`) is a *view* onto it — **Dismiss hides the modal but does NOT stop the drain**; progress keeps flowing to `StatusMessage`.
- **Launch**: `DrainUnsubInBackground` resumes a leftover queue (dismissable modal + status bar).
- **Close**: `MainWindow.OnClosing` → `Vm.BeginCloseDrain(closeNow)`; if queued it cancels the close, runs the drain, and the completion callback calls `Close()` (`_allowClose` guards re-entry). Force-quit mid-drain → queue persists → resumes next launch.
