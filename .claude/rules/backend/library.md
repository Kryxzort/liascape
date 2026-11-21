---
paths:
  - "src/backend/Helpers/LibraryService.cs"
  - "src/backend/Helpers/LibraryStore.cs"
  - "src/backend/Helpers/Presets.cs"
  - "scripts/test-presets.sh"
  - "src/backend/Helpers/SceneProperties.cs"
  - "src/backend/Helpers/SceneLoudnessPlanner.cs"
  - "src/backend/Helpers/DownloadHelper.cs"
  - "src/backend/Helpers/ImportService.cs"
  - "src/backend/Helpers/FolderScanner.cs"
  - "src/backend/Web/FolderImportOps.cs"
  - "src/backend/Web/FolderWatch.cs"
  - "scripts/test-folder-import.sh"
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
- `local/<id>` is a symlink into the user's Wallpaper Engine folder (Steam owns the bytes); `workshop/<id>` is an owned copy ("Download without subscribing").
- "Unsubscribe without deleting" (`LibraryService.KeepOwnCopy`) turns a `local/<id>` link into an owned copy at the same path, copied through a staging folder under `.trash` and swapped in for the link before the unsubscribe is queued; never moved to `workshop/<id>`: the path is the item's identity (playlist, playing item, sidebar), and the reconcile of direct downloads would swap a `workshop/<id>` copy back to a link and delete it while Steam's folder still exists. So test "is it a link", never "is it under `local/`", for "Steam owns it" (legacy LWE then launches by path). Subscribed again (auto-import on), the copy gives way to a link at the same path once Steam's folder is whole (`LibraryService.RelinkOwnCopies`). Guard: `scripts/test-steam-signin.sh` § 3 i.
- A scene's play path IS its folder (no `.scene` marker): `PlayerHelper.IsScenePath` = no media extension. Scene-ness on load: index `IsScene`, else `project.json` `type:"scene"`, else a preset (§ Presets), else a `scene.pkg`.
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
- A preset: scene defaults → preset values → the card's tweaks. `ForItem(<preset>)` = its base's properties with the
  preset's values as their `Default` (`WithPreset`: only a value of the type's saved JSON kind that `Coerce` accepts;
  the rest drop alone) and the scene's own as `SceneDefault`; its tweaks live in the preset's own `SceneProps` (equal to
  the preset's value → dropped). `PlayerMap` sends the preset's values, never the scene's defaults. Its loudness is its
  own: estimated on the base's folder with that merged map, stored under the preset's path (`SceneLoudnessPlanner.Estimate`).
  Guard: `scripts/test-presets.sh` § 2.

## Presets (Wallpaper Engine's format, from real Workshop items)
- Recognise a preset by its `project.json`: no `type` key, a `preset` object and a `dependency`; never by `type` (WE
  writes none) or a `Preset` tag (`project.json`'s `tags` hold only a genre: `Unspecified`, `Music`, `Anime`).
  Fixtures: `scripts/test-fixtures/presets/<presetId>/`.
- Its keys: `dependency`, `preset`, `preview`, `tags`, `title`, `visibility`, and sometimes `description`,
  `contentrating`, `ratingsex`, `ratingviolence`, `snapshotformat`, `snapshotoverlay`. No `file`, `general`,
  `workshopid`, `version` or `scene.pkg`: a preset folder can't play on its own.
- `dependency` = the base item's Workshop id, digits as a JSON string.
- `preview` names its own preview (`preview.jpg` or `preview.gif`) in the preset folder.
- `preset` maps a property name to its value in the base scene's own `general.properties` encoding (§ Scene
  properties): `bool` true/false or 0/1 (any other number = its type changed: dropped), `slider` a number (float
  noise kept, `0.89999998`), `color` `"r g b"` 0–1, `combo` the option's value string, `textinput` a string.
- A `scenetexture` value is `"files/<name>"`, relative to the preset folder (its `files/`), or `""`; resolve it
  against the preset folder, never the base's. `files/` holds only what those values name; it overlays no base file.
  PNG, JPEG or GIF. `WithPreset` takes it only as a relative path with no `..` to an image file whose real path is
  inside the preset's real folder, and `PlayerMap` sends that absolute path (the core loads it into the slot) and no
  other file path (`SceneProp.PresetImage`: a scene's own default naming a file is never sent); anything else sends
  nothing (the base's texture). Guards: player-selftest `PresetImageAssertions`, `scripts/test-presets.sh`
  § 2 preset images.
- `preset` also carries WE's own per-wallpaper settings that are not scene properties: `_d0` (`null`), `alignment*`,
  `rate`, `wec_*` (colour correction), and when the base supports them `audioprocessing`, `cameraparallax`, `volume`,
  `wcc_*`. A base property the preset lacks (saved against an older base) keeps the base's value.
- Steam's tags (not `project.json`'s) carry `Preset` plus the base's type tag (`Scene` or `Web`), and never
  `Wallpaper` / `Customizable`; Steam lists the base as the item page's one "Required items" link.
- In the library (`Helpers/Presets.cs`): a preset is its own scene item (`IsScene`, `isPreset`); its identity is its
  own folder, never the base's. A `preset` object with a missing or non-digit `dependency` is still a preset (greyed);
  the WE auto-import brings in only one with a digit `dependency`, and only with `AllowScenes` on.
- A preset added from a place on this PC (Browse's "Wallpaper Engine (Local)", a folder import, a watched folder) brings
  its base from that same place the way the preset came, through ONE helper (`PresetDownloads.AddBaseFromAsync`; the
  route's own `add`: that source's `/download`, or the import's link / copy and watched mark): a base the library has is
  reused; one there that isn't a scene is never added and its kind lands in `LibMeta.BaseKind` (the reason); none there →
  "Needs its base scene". Steam's downloads: `.claude/rules/backend/sources-steam.md` § Workshop downloads.
- Find the base by Workshop id at every ask (`Presets.BaseDirOf`: `local/<id>`, else `workshop/<id>`, else the
  `imported/` entry whose `WorkshopId` is the id); never keep its path or a link target: the base's form changes at the
  same path (`KeepOwnCopy`, `RelinkOwnCopies`).
- Reasons (`presetReason`, exact text), first match wins (`Presets.StatusFor`): no base id or its own id → "Its preset
  file names no base scene"; `LibMeta.BaseKind` (the download's) not `scene` → "Its base is a(n) {kind} wallpaper, not a
  scene"; no base folder (or one with no kind yet) → "Needs its base scene"; the base folder a preset or a video → the
  same "Its base is a …" (never resolved through another preset); the legacy engine → "Presets play only in the
  Liascape player". `baseTitle` = the base's own title, else `LibMeta.BaseTitle`. Guard: `scripts/test-presets.sh` § 1.

## Steam tags, trailers and frame sizes (`Web/LibraryFactsOps.cs`)
- One background pass, single-flight, kicked after the startup sync, `/library/sync`, an import and a download. It writes each fact field-level (`UpdateIndex`) and asks only for what an item doesn't have yet: never on every launch.
- Tags and trailers: ONE `GetDetails` over Steam's client protocol for every Workshop item missing either (`Helpers/SteamWorkshopDetails.cs`, up to 1000 ids a request: measured, docs/decisions.md § "Ask Steam for a whole library's details in one request"). A Workshop item's id is its index `workshopId`, else its `local/` or `workshop/` folder name.
- Cache per item: tags → `tags` (never asked again; never written over a download's); no such public item → `tagsCheckedAt` (asked again after 30 days); a trailer → `youtubeUrl`; none → `trailerCheckedAt` (re-check after 30 days); couldn't ask → store nothing (never save "can't tell" as "none"). Only a trailer falls back to reading the Workshop page (through `SteamGate`).
- Frame size: read only for an item whose Steam tags carry no resolution — ffprobe for a video or image (rotation applied), a scene's `general.orthogonalprojection` (scene.json, loose or in scene.pkg); `frameSize` + `frameSizeOf` (the file's size + mtime: a changed file is read again), one ffprobe at a time. `LibraryService.Build` adds its Workshop resolution tag (`WorkshopTags.ResolutionTagOf`) to the item's tags.
- Steam's tags beat project.json's (`Build`): its age rating and resolution tag too. Guard: `scripts/test-library-facts.sh`, matrix probe-filters `lib:steamTags`.
- Size on disk (the Library sidebar's size pill): measured in the same pass, never on a request (`GET /library` reads `diskBytes`) — the bytes of the regular files under the item folder's real path (a `local/<id>` link measured at Steam's folder), never through a link inside it, a hard-linked file once (`statx` dev + inode); `diskBytes` + `diskBytesOf` (the real path + the newest write time of the folder and its direct entries: a moved link or a changed item is measured again). Guard: `scripts/test-library-facts.sh` § 7, probe-steam `lib:ws:size`.

## Trash, delete and Delete from Source
- Trash moves the item folder to `.trash/<batchId>/…` with a `<key>.meta.json` (the whole `LibMeta`); Undo (`RestoreBatch`) replays it. Trash is purged at startup/close.
- Delete keeps the Steam subscription. With `AutoAddWeWallpapersToLibrary` on (the default) a subscribed Workshop item (GET /library `subscribed`: `WorkshopSubOps.MarkSubscribed`, the Browse toggle's rule) has no plain Delete in the UI, or the next import brings it back: its Delete is Unsubscribe (Delete from Source) and "Unsubscribe without deleting" (`/workshop/unsubscribe-keep`); the library's own copy deletes plainly. Guard: probe-steam `side:unsub:*`.
- Delete from Source = queue the unsubscribe (`WorkshopUnsubQueue`, `~/.config/liascape/workshop_unsub.json`: `Pending` / `Blocked`) + trash; the backend sends it after a 5 s Undo window (`SteamOps.DrainAfterUndoWindow`; an Undo inside it never reaches Steam), never the UI. Never delete the Workshop folder ourselves: Steam removes it after the unsubscribe; `Blocked` keeps auto-import from resurrecting it meanwhile.
- Auto-import snapshots `pending ∪ blocked` once per pass (`SnapshotBlockedSet`), never a per-folder check.
- Undo of a Delete from Source re-subscribes when Steam already unsubscribed it (`Withdraw` → `Unsubscribed` → `WorkshopDownloader.ResubscribeAsync`). Guard: `scripts/test-steam-signin.sh` § 3.
- An Undo the backend accepts always wins over the drain: a drain claims each id right before it reaches Steam (after its turn at the Steam client; `WorkshopUnsubQueue.Claim`) and Undo takes a batch's ids back in one step under the same lock (`Withdraw`). Withdrawn first = never sent; claimed first = Undo answers `ok: false` with "Too late to undo…", changes nothing and keeps the batch (Undo again once Steam answered). Never check pending, then send. Guard: `scripts/test-steam-signin.sh` § 3 i. "an Undo while…".

## Folder import and watched folders
- One scanner for both (`Helpers/FolderScanner.cs`): a folder with a `project.json` is one WE item (scene, preset, or video whose file is there), never looked into; a loose video / gif / picture is one item; other folders recurse. Each real folder once (link loops), dot-entries and the library skipped, an unreadable folder reported. It only lists and reads `project.json`.
- A preset (`Presets.Read`) scans as a scene item (`preset`, `baseWorkshopId`), gated by "Play scenes" like one, and imports as its own preset item at `imported/<name>` (§ Presets). After a batch, each preset it added brings its base from the same tree by Workshop id (`Result.WeFolders`: every WE item folder's id, unsupported ones too) through `AddBaseFromAsync`, linked or copied like the batch: the dialog's scanned folders (`/library/import-found` `roots`, only a root holding a ticked path; the base ticked or not, never one in `skip`), a watch's own scan (never one in its `Skip`, nor one still being written: its next pass). Never a Steam subscription. A base that turns up later in a watched folder comes in as any scene and the presets' base pass (`PresetBases`) refreshes a rotation's skip flags. Guard: `scripts/test-folder-import.sh` § presets.
- Import shows the scan first (`/library/scan`); only the ticked paths land (`/library/import-found`, identified again). "Already in your library" = the same source (`SourceUrl` `import:<path>`) or Workshop id.
- An item whose real path is inside a Steam Workshop folder (`WorkshopDownloader.SteamWorkshopRoots`: the WE folder setting, standard / Flatpak / snap Steam, every `libraryfolders.vdf` library) is a subscription (`Found.Subscription`): never imported, linked or copied, by the dialog, `/library/import-found` or a watch; the dialog lists it apart, disabled ("From your Steam subscriptions"), naming the WE auto-import as its way in. Steam deletes its files on an unsubscribe. Guard: `scripts/test-folder-import.sh` § steam, probe-import `import:steam`.
- Everything lands in `imported/<name>`: a link to the source (a WE folder's link is the item folder; a file's is `<key>.<ext>`) or a copy (a WE folder through a staging folder under `.trash`). A re-import keeps the item's form. Never move one under `local/` or `workshop/`: those mean Steam's folder.
- An imported item's Workshop id counts as in the library for the WE auto-import too (`LibraryService.ExistingWorkshopIds`): subscribing to it adds no `local/<id>` beside it; the imported one stays the item, Steam's folder only the subscription's. Once it is deleted the next pass links Steam's folder. Guard: `scripts/test-folder-import.sh` § subscribed.
- Delete or trash through `LibraryService.TryDeleteDir`: a link is unlinked, never deleted through. Never write, move or delete a user's source. Guard: `scripts/test-folder-import.sh` § delete.
- Watched folders (`AppSettings.WatchedFolders`, `Web/FolderWatch.cs`): inotify, debounced, plus a periodic pass; a file younger than the stable time waits. Every import runs through `FolderImportOps`' one gate. Items carry `LibMeta.WatchedFrom` + `SourceSig`; a deleted or trashed one joins the folder's `Skip`.
- A source gone from its watched folder removes the item only when it is a link (`AppOps.Trash(…, undoable: false)`: the playlist follows); a copy stays, unmarked. Nothing leaves while the folder is missing, reads as empty, or the source sits under an unreadable folder. Why: `docs/decisions.md` § "Remove only the link when a watched folder's file goes". Guard: `scripts/test-folder-import.sh` § watch.

## WE auto-import
- `LibraryService.SyncWallpaperEngine` creates `local/<id>` links + index entries; it runs at `serve` start (then WS `library-synced`) and in `liascape restore` before playback. Steam's tags for what it adds: § Steam tags, trailers and frame sizes.
- With `AutoAddLibraryToPlaylist` on, new items join the playlist and `LastSession` mid-session.
