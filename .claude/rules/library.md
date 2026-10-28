---
paths:
  - "src/backend/Helpers/LibraryService.cs"
  - "src/backend/Helpers/LibraryStore.cs"
  - "src/backend/Helpers/SceneProperties.cs"
  - "src/backend/Helpers/DownloadHelper.cs"
  - "src/backend/Helpers/ImportService.cs"
  - "src/backend/Models/LibraryItem.cs"
---

## Library layout (per-item folders + per-source `index.json`)

Library root: `~/.local/share/liascape/library/`. Config: `~/.config/liascape/settings.json` — Cache: `~/.cache/liascape/`.

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

One `index.json` per source folder, keyed by `<key>` (`<id>` for workshop/local, `<name>` for web/imported). Saved atomically (`AtomicFile`: temp + rename) and read with a retried parse — written in place, a read mid-save got an EMPTY index (matrix `race:indexSaveLoad`). One `LibMeta` per item:

```
SourceUrl, Title, IsScene, WorkshopId, Volume?, Speed?, LoudnessI/TP/LRA/Thresh?, LoudnessSkip?,
LoudnessSeconds?, LoudnessPartial?, LoudnessState?, Crashed, Whitelist, SceneProps?,
Resolution, AgeRating, YoutubeUrl, PageUrl, AuthorName, Description,
FileSizeBytes?, Subscriptions?, Favorites?, Views?, Tags[]
```

- Serialized `WhenWritingNull` → **absent `volume`/`speed` means "use global."**
- `Locate(mediaPath) → (source, key)`: splits the path relative to the library root — `parts[0]` = source, `parts[1]` = key. Works for a media file (`…/<source>/<key>/<file>`) **and** a scene folder (`…/<source>/<key>`).
- `GetMeta` / `SetMeta(path, mutate)` (lock-guarded read-modify-write, creates entry) / `Remove`. `LoadIndex` re-reads the file each call (no cache) — daemons/other writers may have changed it.
- **Every index write is a read-modify-write under that one lock**: `SetMeta`, `Remove`, or `UpdateIndex(source, idx => … return save?)` (reentrant — a writer moving entries between two indexes nests them). `SaveIndex` is private. Trash, undo (`RestoreBatch`), the WE sync and the direct-download reconcile used to `LoadIndex`, do their work, and save that copy outside the lock — over an override saved meanwhile (matrix `race:indexLostUpdate`: 2–3 of 40 slider saves reverted by trash/undo cycles of another item; 0 since). Every one of those also holds `FileLock` on `index.json.lock` (an `flock` shared with every liascape process — the CLI's `--restore` sync, a keybind run locally, the daemons), taken inside `_lock`.

## Scenes are **folders**, not marker files

A scene's `VideoPath` **is its item folder** (`workshop/<id>` or `local/<id>`) — there is no `.scene` marker. `PlayerHelper.IsScenePath(path)` = "the path has no media file extension" (a folder ⟺ scene; a `.mp4`/`.png` ⟺ video/image). Scene-ness on load = index `IsScene`, else `project.json` `type:"scene"`, else a `scene.pkg` in the folder. LWE launches a **local** scene by **id** (its native WE-dir lookup) and an **owned** (`workshop/`) scene by **dir path**. `LibraryItem.CopiedSceneDir` = the owned folder (null for local). See `player.md`.

## Per-item volume/speed overrides (live)

- `LibraryService.ReadVolumeOverride/ReadSpeedOverride/IsWhitelisted/HasCrashed` → `LibraryStore.GetMeta(path)?.X`. **`PlayerHelper`'s private `ReadVolumeOverride/ReadSpeedOverride` delegate to these** — so *every* playback path (initial launch, playlist advance, transitions, scene launch, option baking) reads the same index.
- `SaveVolumeOverride/SaveSpeedOverride` **drop the key when it equals the global** (volume `== Settings.Volume`, speed within 1e-6) → "use global."
- **Live apply** (no restart): `POST /library/volume|speed` → save → `PlayerHelper.ApplyOverrideLive(path)` (mpv `set_property` for video volume/speed; `pactl` for live LWE **scene volume**; scenes are 1× so speed is a no-op). Timed-playlist advances carry the effective volume/speed as **`loadfile` per-file options** (atomic — avoids the post-load reset race). A global settings change applies the *effective* value (`override ?? global`) so it never clobbers an active override.

## Loudness (normalization between wallpapers)

- **Videos:** `ffmpeg loudnorm` pass 1, once per item in the background (`LibraryService.EnsureLoudnessAsync` /
  `BackfillLoudnessAsync`) → all four `loudnessI/TP/LRA/Thresh` (`ReadLoudness` requires all four) or
  `loudnessSkip` (no audio track / silent); applied as mpv's `af` loudnorm (`LoudnormAf`).
- **Scenes (liascape-player only):** learned by the player over the first ~60 s of audible play and refined on every
  later play up to 30 min of audible play in all (`scene.loudness`, player-adapter.md § Scenes → "Loudness") →
  `loudnessState` (the player's measurement: a BS.1770 block-loudness histogram + peak, opaque — the next play's
  source continues it as its `loudness_seed`) + `loudnessSeconds` (audible seconds it covers, every play) +
  `loudnessPartial` (true = less than the window: switched away early) + the APPLIED `loudnessI` (LUFS) /
  `loudnessTP` (SAMPLE peak, dBFS) — moved only by ≥ 0.5 LU/dB. No LRA/Thresh, so the video path never reads it.
  `MergeSceneLoudness`: the report covering more seconds replaces the measurement. An entry without
  `loudnessState` (learned before 2026-10-28) is applied as is, never a seed, and re-learned by the next complete
  report (no migration). Applied as the scene source's `gain.normalize`. Legacy LWE scenes: not normalized.

## Scene properties (a WE scene's own options — `Helpers/SceneProperties.cs`)

A scene's `project.json` → `general.properties` (colours, sliders, toggles, combos, text) — the card settings modal's
"Scene properties" (web-ui.md). **Overrides live per item in `LibMeta.SceneProps`** (`name → value`, absent = every
property at the scene's own default), in **WE's own encoding**: bool `true/false`, slider a number, colour `"r g b"`
(0–1 floats), combo the option's key (a string; a numeric option value as LWE keys it — `std::to_string(int)`), text
a string. `LibraryService.SaveSceneProp(path, name, value?)` — field-level under the index lock; a value equal to the
default (colours by component) **drops** the key, `value` null = back to the default, `name` null = all; validated
by `SceneProperties.Coerce` (slider clamped to min..max and rounded when `fraction: false`; colour from `"r g b"`
(0–1, or 0–255 when any part > 1), `[r,g,b]` or `#rrggbb`; combo must be an option; text ≤ 4096). Trash/undo carry
it with the rest of the `LibMeta`.
- **Parsing** (`Parse`, cached per file by mtime+size; anything malformed is skipped, never thrown): display order =
  `order`, else `index`, else file order. Types (survey of the 96 SFW corpus scenes, 2066 properties): **editable**
  `bool`, `slider` (min/max/step/fraction/precision; a default outside its own range widens it — one corpus slider has
  0.4 with min 0.5), `color`, `combo` (options; no options → dropped), `textinput`; **labels** `text` (also an untyped
  property and `"Text"` — HTML: tags stripped, entities decoded, never rendered as HTML — no remote images/links; an
  image-only one is dropped) and `group`; **not editable** (listed with a reason) `scenetexture` / `file` /
  `directory` (need a file picker — skipped for now) and `usershortcut` (a Windows app launcher), any unknown type.
  Labels: `ui_*` localisation keys → English (`ui_browse_properties_scheme_color` → "Scheme color", others humanised).
- **Visibility** (`Visible(condition, effective values)`): WE's `condition` is JS — evaluated as a subset: `<name>.value`
  (whitespace around `.` allowed, as in JS — corpus), literals, `! && || == != === !== < <= > >= + -`, parentheses, a
  stray `x.value=true` (a JS assignment → its value); JS loose equality (`"2" == 2`, `true == 1`). Anything it can't
  evaluate (a syntax error, a bare identifier — a ReferenceError in JS) → **shown**. Every one of the corpus's 868
  conditions parses (self-test).
- **Playback.** liascape-player: `SceneProperties.PlayerMap` (overrides that name an editable property, encoded for the
  player — a colour as `[r,g,b]`) is the source's `scene_props` at every open and live (player-adapter.md § Scenes).
  Legacy: `--set-property name=value` per override at LWE's launch (`CliArgs`) — **launch-only** (LWE has no live
  property IPC), so a change shows at the scene's next start; the modal says so.

## Animated preview

The web UI animates library/playlist bar cards from the source's **preview gif/webp** (not a transcode). It lives **inside the item folder** — `preview.gif`/`webp` (workshop/local) or `<key>.gif`/`webp` (web). `FindAnimated` resolves it → `LibraryItem.AnimatedThumbnailPath`; `DownloadHelper.SaveAnimatedPreviewAsync` persists an animated download URL (gif/webp/apng only). Items with no gif asset → the UI plays the local video on hover.

## Soft delete / trash / restore

- **Trash** moves the item **folder** to `.trash/<batchId>/<source>/<key>/`, writes a `<key>.meta.json` (`TrashedEntry` = source + key + isScene + the `LibMeta`), and removes the index key. Scene = the folder itself; video = its parent folder.
- **RestoreBatch** moves folders back + replays index entries. **Delete** removes the folder + index key.
- **Symlink safety:** `Directory.Delete(local/<id>, recursive:true)` on a **symlinked** dir *unlinks the symlink* — it does **not** touch the user's WE source files (verified on .NET 9). So deleting a `local/` item never destroys subscribed wallpapers.
- Trash purged on close/startup. **Ctrl+Z** restores the last batch (in-memory batch stack in `AppOps`).

## File paths beyond library

- `~/.config/liascape/lwe.pid` — PIDs of running LWE processes
- `~/.config/liascape/user_mute.state` — presence = user muted (guards auto-unmute)
- `~/.cache/liascape/playlist_observer_paths.json` — shuffled order for playlist observer reconnection
- `~/.cache/liascape/we_thumbs/<workshopId>.jpg` — static frame extracted from GIF thumbnails
- `~/.config/liascape/serve.port` — the `serve` backend's chosen port (Electron reads it)
- `~/.config/liascape/workshop_unsub.json` — durable "Delete from Source" unsubscribe queue (below)

## Delete vs Delete from Source (workshop items)

Orchestrated in **`Web/AppOps.cs`**:

- **Delete** (`AppOps.Trash`): soft-delete to `.trash/`, undoable. **Keeps** the Steam subscription. **Exception:** when `AutoAddWeWallpapersToLibrary` is on, a plain delete of a workshop item would be re-imported next launch, so it enqueues the unsubscribe for any item with a `WorkshopId`.
- **Delete from Source** (`AppOps.DeleteFromSource`, `POST /workshop/delete-from-source`): enqueues the workshop id + soft-deletes. Applies to any workshop item — symlink OR copy (`WorkshopId != null`); the drain works by id. The UI hides this when auto-import is on (the trash button already does it).

**We never delete the workshop folder ourselves.** Unsubscribing makes Steam remove the folder + its `appworkshop_431960.acf` entry together on its next sync. A `blocked` set keeps AutoImport from resurrecting the lingering folder until Steam cleans it.

### `WorkshopUnsubQueue` (`Helpers/WorkshopUnsubQueue.cs`)
- Persisted JSON `~/.config/liascape/workshop_unsub.json`: `{ Pending[], Blocked[] }`. `pending` = awaiting the unsubscribe POST; `blocked` = unsubscribed, AutoImport skips while Steam's cleanup lags.
- API: `AddPending`, `RemovePending` (undo), `MarkBlocked` (pending→blocked), `Unblock` (re-subscribe / WE-Local re-add: drop from both), `SnapshotPending`, `HasPending`, `SnapshotBlockedSet` (one read per pass), `PruneBlocked(folderExists)`. Thread-safe (re-reads under a lock per call).
- **AutoImport** (`SyncWallpaperEngine`) snapshots `pending ∪ blocked` once into a `HashSet` and skips matches (never `IsBlocked` per folder).

### Drain (`WorkshopDownloader.DrainUnsubQueueAsync`)
- Per id: `SetSubscribedAsync(subscribe:false)` → `MarkBlocked(id)`. **No folder delete** — Steam does it. Throttled 300ms; failure leaves the id pending. Aborts the rest on a 429 rate-limit.
- **Prune** (`PruneBlocked`, launch, background): drops blocked ids whose folder is gone; parses `libraryfolders.vdf` once and reuses across ids.
- **One drain at a time** (`SteamOps`, Interlocked guard). Progress → WS `unsub-progress`; the modal is a dismissable *view* (Dismiss hides it, the drain keeps running). Force-quit mid-drain → queue persists → resumes next launch.
