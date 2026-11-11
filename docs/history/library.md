<!-- Archived verbatim from .claude/rules/library.md (2026-11-11 docs rework): the old rule text with its history,
     measurements and owner quotes. NOT loaded automatically and may be stale: the code, CLAUDE.md and
     .claude/rules/** win. -->

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
SceneLoudness? {<fingerprint>: {estimate?, live?}}, SceneLoudnessFp?, Crashed, Whitelist, SceneProps?,
Resolution, AgeRating, YoutubeUrl, TrailerCheckedAt?, PageUrl, AuthorName, Description,
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
  `loudnessSkip` (no audio track / silent); applied as ONE fixed gain for the whole play (`LoudnormAf` →
  `lavfi=[volume=<g>dB]`), **Spotify's rule** (owner 2026-11-11): `g = target − I`, but a boost only as far as the
  true peak allows with 1 dB of headroom (`min(target − I, −1 − TP)`) — a quiet item with big peaks plays under the
  target rather than be limited (owner checked by ear 2026-11-11: the worst two, 3170457299 at ~14 dB and 2102734753 at
  ~7.5 dB under the target, sound fine next to the rest — keep it). **Never ffmpeg's `loudnorm` at playback**: even `linear=true` with the measurements
  falls back to its DYNAMIC mode (a 3 s look-ahead volume rider — ramps, pumping, a lurch at the loop) when the gain
  would cross its TP or LRA > its target LRA; 62 of the owner's 189 videos did (3019725456: +3 dB hot at the start,
  climbing to +4.4 dB over its last 4 s). `loudnorm` stays only as the pass-1 MEASUREMENT.
- **Scenes (liascape-player only), per audio configuration** (2026-10-29, docs/TODO.md "Offline scene loudness →
  integration"): `sceneLoudness` = `{<fingerprint>: {estimate, live}}` + `sceneLoudnessFp` (the CURRENT configuration).
  The fingerprint is the offline estimator's (`liascape-player scene-loudness`) of the scene's sound under its user
  properties — a property that changes no sound keeps it; toggling a sound off and back on returns to that
  configuration's own data. **`estimate`** `{lufs (null = no sound), peakDbfs, seed (the estimated histogram scaled to
  10 s of play), confidence high|medium|low, notes, lufsIfCoherent, model, v, at}` — computed on import, at startup
  for what has none, by Settings → "Scene loudness", and on every property commit (`SceneLoudnessPlanner`,
  web-backend.md § Scene loudness). **`live`** `{state (the player's BS.1770 block-loudness histogram + peak, opaque —
  the next source's `loudness_seed`), seconds (audible, every play of this configuration), lufs, peakDbfs, partial}`
  — the player's `scene.loudness` reports (player-adapter.md § Scenes → "Loudness"), stored under the report's `key`
  (else the current configuration, else `""`); `MergeSceneLoudness`: the report covering more seconds replaces it.
  The APPLIED `loudnessI` (LUFS) / `loudnessTP` (SAMPLE peak, dBFS) = the current configuration's live value once it
  has one, else its estimate — moved by ≥ 0.5 LU/dB within one configuration, set exactly on a configuration change
  (`MergeSceneEstimate`); no LRA/Thresh, so the video path never reads it. The seed a new source continues = the
  current configuration's live state, else its estimate's seed — an estimate never displaces live data (the
  player's `Book` adopts a seed only when it covers more). Applied as the scene source's `gain.normalize` — **set once
  per play** (owner 2026-11-06): the applied value is what a NEW play starts with; a playing source keeps its
  `gain.normalize` to its end, except once, when its configuration's first 60 s window completes (`WindowReached` —
  a play that started from an estimate, a partial or nothing); every later report refines the stored value for the
  next play only (player-adapter.md § Scenes → "Loudness" → "Set once per play"). No
  estimate (not estimable / failed) = learn on first play as before (unity until the window lands). The flat `loudnessState/Seconds/Partial` of
  before were moved by a one-off script (no migration code). Legacy LWE scenes: not normalized.

## YouTube trailers (`youtubeUrl` + `trailerCheckedAt` — `Web/TrailerOps.cs`)

A trailer is part of the Workshop LISTING, not the downloaded files (`project.json` has no field for it): a download
from the app's Workshop browser stores it, but items auto-imported from WE subscriptions never had one (owner
2026-11-11). Wallpaper Engine gets it from the Steam client's UGC API (an item's additional previews); **this app asks
the same servers anonymously over the client protocol** (`Helpers/SteamWorkshopDetails.cs`, SteamKit2:
`PublishedFile.GetDetails` + `includeadditionalpreviews`, 100 items a request — the owner's 275 in 7.6 s, 23 trailers),
and only reads the item's public Workshop page (`SteamWorkshopScraper.CheckYoutubeAsync`: `YOUTUBE_VIDEO_ID`, through
`SteamGate`) for what those servers don't answer or when they're unreachable; the page fallback alone waits out a
steamcommunity cooldown (the client protocol isn't steamcommunity.com). **Cached per item**:
found → `youtubeUrl` (never looked up again); page read, none → `trailerCheckedAt` (unix s; re-checked after 30 days);
couldn't check (no connection, an error page) → nothing stored, retried next start — never "can't tell" saved as "none"
(WE's own offline-mode bug). Steam rate-limits steamcommunity.com per IP for a long while once tripped (a burst of ~150 quick reads → 429s for 30+
min, the owner's browser included): one page per 4 s (a ONE-TIME fill — cached after), a 429 waits 5 min (×3) then the
run stops and the next start continues; 3 real failures in a row = offline → stop. (Faster routes need a Web API key or a
signed-in access token — `IPublishedFileService/GetDetails`; the keyless `GetPublishedFileDetails` has no previews.) single-flight; run after the
startup WE sync and `/library/sync`; each find → WS `library-item-changed {path, youtubeUrl}`. The sidebar's preview
switch offers YouTube only while online (`useOnline`).

## Scene properties (a WE scene's own options — `Helpers/SceneProperties.cs`)

A scene's `project.json` → `general.properties` (colours, sliders, toggles, combos, text) — the Library sidebar's
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
- `~/.config/liascape/serve.port` — the `serve` backend's chosen port (Electron reads it); `serve.token` beside it = its API token (0600; web-backend.md § Local API security)
- `~/.config/liascape/workshop_unsub.json` — durable "Delete from Source" unsubscribe queue (below)

## Delete vs Delete from Source (workshop items)

Orchestrated in **`Web/AppOps.cs`**:

- **Delete** (`AppOps.Trash`): soft-delete to `.trash/`, undoable. **Keeps** the Steam subscription. **Exception:** when `AutoAddWeWallpapersToLibrary` is on, a plain delete of a workshop item would be re-imported next launch, so it enqueues the unsubscribe for any item with a `WorkshopId`.
- **Delete from Source** (`AppOps.DeleteFromSource`, `POST /workshop/delete-from-source`): enqueues the workshop id + soft-deletes. Applies to any workshop item — symlink OR copy (`WorkshopId != null`); the drain works by id. The UI hides this when auto-import is on (the trash button already does it).
  The Browse sidebar's **Unsubscribe** (owner 2026-11-11; `POST /workshop/unsubscribe`, `Web/WorkshopSubOps.cs`, sources.md §
  Download) on an item the library holds (every `LibraryItem` with that `WorkshopId`) IS this — same trash batch, same Undo; on
  one it doesn't hold, only the queue (no batch). A drain asked for while one runs runs once more after it (`SteamOps.StartDrain`).

**We never delete the workshop folder ourselves.** Unsubscribing makes Steam remove the folder + its `appworkshop_431960.acf` entry together on its next sync. A `blocked` set keeps AutoImport from resurrecting the lingering folder until Steam cleans it.

**Undo of a Delete from Source** (owner 2026-11-11: "what if i unsubscribe + undo / does it resubscribe? it doesn't right?" — it
didn't: the item came back while Steam deleted its folder): `AppOps.Undo` → `WorkshopUnsubQueue.Restore(id)` per item — true when
Steam had ALREADY unsubscribed it (blocked, no longer pending) → `WorkshopDownloader.ResubscribeAsync` in the background, the way
the download mode subscribes: `steamapp` the Steam client, `subscribe` the sign-in, else / on failure the item's page through the
**Steam to-do** (`Web/SteamTodo.cs`, one page at a time — sources.md § Download) + WS `unsub-progress {finished, message}` for the
status bar ("Undone — to keep it subscribed, click Subscribe on the page Steam opened (if it says Subscribed, you're set), then
Next." — the page route can't know whether the user clicked Unsubscribe); `steamcmd` nothing. An unsubscribe that completes AFTER
an Undo restored the item (`MarkBlocked` returns false — it wasn't pending any more) blocks nothing and re-subscribes it (the
drain's end; the Steam to-do's Next / "Let the Steam app do all N" the same way). **The page route's unsubscribe is blocked on
the user's Next, not when its page opens** (2026-11-11, the Steam to-do): until then the id stays `pending` — so an Undo meanwhile
is a plain un-queue (`Restore` → false) and `SteamTodo.DropUnsubscribe` takes its entry out of the to-do (the next page opens if
it was the current one); Skip / Stop = kept subscribed → `Unblock` (out of pending AND blocked). Guard: `test-steam-signin.sh`
§ 3 (undo after the Steam client unsubscribed → subscribed again; after the to-do's Next → subscribed again through the Steam
client; Steam unreachable → the page + the message) and § 1 (Next / Skip / Stop on unsubscribe entries).

### `WorkshopUnsubQueue` (`Helpers/WorkshopUnsubQueue.cs`)
- Persisted JSON `~/.config/liascape/workshop_unsub.json`: `{ Pending[], Blocked[] }`. `pending` = awaiting the unsubscribe POST; `blocked` = unsubscribed, AutoImport skips while Steam's cleanup lags.
- API: `AddPending`, `RemovePending` (undo), `MarkBlocked` (pending→blocked; false = no longer pending — undone meanwhile), `Restore` (undo: drop from both, true = already unsubscribed), `Unblock` (re-subscribe / WE-Local re-add: drop from both), `SnapshotPending`, `HasPending`, `SnapshotBlockedSet` (one read per pass), `PruneBlocked(folderExists)`. Thread-safe (re-reads under a lock per call).
- **AutoImport** (`SyncWallpaperEngine`) snapshots `pending ∪ blocked` once into a `HashSet` and skips matches (never `IsBlocked` per folder).

### Drain (`WorkshopDownloader.DrainUnsubQueueAsync`)
- Per id: `SetSubscribedAsync(subscribe:false)` → `MarkBlocked(id)`. **No folder delete** — Steam does it. Throttled 300ms; failure leaves the id pending. Aborts the rest on a 429 rate-limit. Without a usable sign-in / under `steampage`: the Steam to-do (sources.md § Unsubscribe); ids already waiting in it are skipped by a later drain (`SteamTodo.QueuedUnsubscribes`).
- **Prune** (`PruneBlocked`, launch, background): drops blocked ids whose folder is gone; parses `libraryfolders.vdf` once and reuses across ids.
- **One drain at a time** (`SteamOps`, Interlocked guard). Progress → WS `unsub-progress`; the modal is a dismissable *view* (Dismiss hides it, the drain keeps running). Force-quit mid-drain → queue persists → resumes next launch.
