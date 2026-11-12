---
paths:
  - "src/backend/Helpers/LibraryService.cs"
  - "src/backend/Helpers/LibraryStore.cs"
  - "src/backend/Helpers/SceneProperties.cs"
  - "src/backend/Helpers/SceneLoudnessPlanner.cs"
  - "src/backend/Helpers/DownloadHelper.cs"
  - "src/backend/Helpers/ImportService.cs"
  - "src/backend/Helpers/WorkshopUnsubQueue.cs"
  - "src/backend/Models/LibraryItem.cs"
  - "src/backend/Web/LibraryFactsOps.cs"
  - "scripts/test-library-facts.sh"
---

# Library

Root `~/.local/share/liascape/library/<source>/<key>/` — every item is its own folder; per-source metadata in
`<source>/index.json` (`LibraryStore`, one `LibMeta` per key). Why behind the choices here: `docs/decisions.md` § Library.

## Layout and identity
- Identity = the folder name: `<id>` for `workshop/` and `local/`, `<name>` for web sources and `imported/`.
- `local/<id>` is a symlink into the user's Wallpaper Engine folder (Steam owns the bytes); `workshop/<id>` is an owned steamcmd copy.
- A scene's play path IS its folder (no `.scene` marker): `PlayerHelper.IsScenePath` = no media extension. Scene-ness on load: index `IsScene`, else `project.json` `type:"scene"`, else a `scene.pkg`.
- Deleting a `local/<id>` item unlinks the symlink only; never delete inside the WE folder ourselves.

## The index (`Helpers/LibraryStore.cs`)
- Every index write is a read-modify-write under the one lock + `FileLock` on `index.json.lock`: `SetMeta`, `Remove`, or `UpdateIndex`. `SaveIndex` is private; never `LoadIndex`, work, and save that copy. Guard: matrix `race:indexLostUpdate`.
- `LoadIndex` re-reads the file each call (no cache): other processes write it.
- Serialize `WhenWritingNull`: an absent `volume`/`speed` means "use the global". `SaveVolumeOverride`/`SaveSpeedOverride` drop the key when it equals the global.
- `Locate` refuses a `..` segment.

## Per-item overrides
- Every playback path reads overrides through `LibraryService` (`PlayerHelper`'s private readers delegate to it); effective = `override ?? global` everywhere.
- After saving an override, apply it live (`PlayerHelper.ApplyOverrideLive`).
- A scene's crash mark (`Crashed`) is set by `PlayerHelper.OnSceneBroken` and lifted only by the user (`POST /library/clear-crash` → `LibraryService.ClearCrashed`: field-level, writes only an entry that carries it; then `LiascapePlayerProgram.PushItem` so a rotation's skip flag follows, and `library-item-changed {hasCrashed: false}`). Every gate (Apply, the pickers, the program's `skip`) reads the index fresh. Guard: `scripts/test-item-actions.sh`, probe-sidebar `lib:clearCrash:*`.

## Loudness
- Videos: measure once with ffmpeg `loudnorm` pass 1 (`EnsureLoudnessAsync`, all four values or `loudnessSkip`); play with ONE fixed gain (`LoudnormAf` → `volume=<g>dB`), `g = min(target − I, −1 − TP)`. Never use `loudnorm` at playback — it falls back to dynamic mode and pumps.
- Scenes (liascape-player only): `sceneLoudness[<fingerprint>] = {estimate, live}` + `sceneLoudnessFp` (the current audio configuration). An estimate never displaces live data; the applied `loudnessI`/`loudnessTP` moves only by ≥ 0.5 LU within one configuration. Merge rules: `MergeSceneLoudness`, `MergeSceneEstimate`; how the player applies them: `.claude/rules/backend/player-adapter.md` § Scenes and loudness.
- Legacy LWE scenes are not normalized.

## Scene properties (`Helpers/SceneProperties.cs`)
- Overrides live in `LibMeta.SceneProps` in WE's own encoding (bool, number, colour `"r g b"` 0–1, combo key string, text); a value equal to the default drops the key. Validate with `SceneProperties.Coerce`.
- Parse defensively: skip anything malformed, never throw. Render labels as plain text (strip HTML), never as HTML.
- `Visible(condition, values)`: an unevaluable condition → shown.
- Under legacy they are launch-only (`--set-property`); under liascape-player live (`SceneProperties.PlayerMap`).

## Steam tags, trailers and frame sizes (`Web/LibraryFactsOps.cs`)
- One background pass, single-flight, kicked after the startup sync, `/library/sync`, an import and a download. It writes each fact field-level (`UpdateIndex`) and asks only for what an item doesn't have yet: never on every launch.
- Tags and trailers: ONE `GetDetails` over Steam's client protocol for every Workshop item missing either (`Helpers/SteamWorkshopDetails.cs`, up to 1000 ids a request: measured, docs/decisions.md § "Ask Steam for a whole library's details in one request"). A Workshop item's id is its index `workshopId`, else its `local/` or `workshop/` folder name.
- Cache per item: tags → `tags` (never asked again; never written over a download's); no such public item → `tagsCheckedAt` (asked again after 30 days); a trailer → `youtubeUrl`; none → `trailerCheckedAt` (re-check after 30 days); couldn't ask → store nothing (never save "can't tell" as "none"). Only a trailer falls back to reading the Workshop page (through `SteamGate`).
- Frame size: read only for an item whose Steam tags carry no resolution — ffprobe for a video or image (rotation applied), a scene's `general.orthogonalprojection` (scene.json, loose or in scene.pkg); `frameSize` + `frameSizeOf` (the file's size + mtime: a changed file is read again), one ffprobe at a time. `LibraryService.Build` adds its Workshop resolution tag (`WorkshopTags.ResolutionTagOf`) to the item's tags.
- Steam's tags beat project.json's (`Build`): its age rating and resolution tag too. Guard: `scripts/test-library-facts.sh`, matrix probe-filters `lib:steamTags`.

## Trash, delete and Delete from Source
- Trash moves the item folder to `.trash/<batchId>/…` with a `<key>.meta.json` (the whole `LibMeta`); Undo (`RestoreBatch`) replays it. Trash is purged at startup/close.
- Delete keeps the Steam subscription — except with `AutoAddWeWallpapersToLibrary` on, where it also queues the unsubscribe (else it'd be re-imported).
- Delete from Source = queue the unsubscribe (`WorkshopUnsubQueue`, `~/.config/liascape/workshop_unsub.json`: `Pending` / `Blocked`) + trash. Never delete the Workshop folder ourselves: Steam removes it after the unsubscribe; `Blocked` keeps auto-import from resurrecting it meanwhile.
- Auto-import snapshots `pending ∪ blocked` once per pass (`SnapshotBlockedSet`), never a per-folder check.
- Undo of a Delete from Source re-subscribes when Steam already unsubscribed it (`Restore` → true → `WorkshopDownloader.ResubscribeAsync`). Guard: `scripts/test-steam-signin.sh` § 3.

## WE auto-import
- `LibraryService.SyncWallpaperEngine` creates `local/<id>` links + index entries; it runs at `serve` start (then WS `library-synced`) and in `liascape restore` before playback. Steam's tags for what it adds: § Steam tags, trailers and frame sizes.
- With `AutoAddLibraryToPlaylist` on, new items join the playlist and `LastSession` mid-session.
