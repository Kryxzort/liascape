# PR Adaptation Notes

Things stripped/changed during cherry-pick that must be restored in later PRs.

---

## PR 1 — Theme Switcher (`pr/theme-switcher`)

### APPEARANCE section placed above RENDERING → may need repositioning in **PR 4 (Library UI)**
- In the fork, the theme dropdown lived inside a Library UI-added APPEARANCE section
- On upstream/main base, manually created a new APPEARANCE section above RENDERING
- When PR 4 restructures the settings panel, the theme ComboBox location may shift — check placement

### `StaticResource` → `DynamicResource` replacement done on upstream base
- Globally replaced all palette color refs in `MainWindow.axaml` (BgBase, BgMantle, BgCrust, Surface0, TextColor, Subtext, Muted, Accent, AccentFg, Danger)
- Any future PR adding new AXAML that uses palette colors must use `DynamicResource`, not `StaticResource`, or theming won't work
- PRs 3–11: watch for any new `StaticResource` palette refs introduced by cherry-picks — replace with `DynamicResource`

### `Theme` property added to `AppSettings.cs`
- Upstream/main base doesn't have this — added cleanly
- Other PRs also modify `AppSettings.cs` (PR 2 adds Speed/VideoScale, PR 8 adds AutoMute variants) — maintainer will need to merge all `AppSettings` changes together; no action needed from us

---

## PR 2 — Per-video Volume/Speed Overrides (`pr/per-video-overrides`)

### Scene code stripped from `PlayerHelper.cs` → restore in **PR 10 (Scene Support)**
- `OnSceneCrashed` action declaration (conflict 1 in `3577c17`)
- `IsScenePath()`, `IsLweAvailable()`, `IsSkippedPath()` methods
- `LaunchScene()`, `GetLweSinkInputIds()`, `ApplyLweVolume()`, `ApplyLweMute()`, `RunPactl()` methods
- `IsScenePath` block in `SwitchToFile()` (conflict 2 in `3577c17`)
- Scene transition logic in `SwitchToFile()` (conflict in `f6b4dc6`) — `_prelaunchCts`, `IsLweRunning`, `SpawnLweProcesses`, `KillMpvPaperOnly`, `KillPids`, `ReadCurrentLwePids`, `LwePidPath`
- `KillLweProcess()` call before video→video switch

### `OnSceneCrashed` callback stripped from `MainWindowViewModel.cs` → restore in **PR 10**
- Handler that calls `LibraryService.MarkCrashed`, sets `card.HasCrashed`, removes from playlist if not whitelisted

### `WallpaperResult.cs` — added stubs → restore in **PR 10**
- Added `IsScene` and `WorkshopId` as stub properties (always false/null)
- PR 10 should set these from `project.json` parsing in `WallpaperEngineService`

### New AXAML elements use `StaticResource` palette refs → becomes `DynamicResource` when merged with **PR 1**
- Volume/speed sliders and preview modal additions use `StaticResource` for TextColor, Subtext, BgCrust
- Same issue as PR 3 — maintainer needs to update these refs when rebasing on top of merged PR 1
- After PR 1 merges: rebase PR 2 and change new `StaticResource` palette refs → `DynamicResource`

### `StartPlaylistObserver` infra added ahead of schedule → **PR 9** owns this
- Added `_observerCts`, `StartPlaylistObserver()`, `StopPlaylistObserver()`, `ObservePathAsync()`, `ApplyOverridesForPath()` manually because `d468ac1` referenced them
- PR 9 commit `289ef76` defines these — when cherry-picking PR 9, these will already exist → trivial conflict, keep current version

### `ApplyTimedPlaylist` call in `RunAsDaemon` — stripped `WaitForVideoEnd` param → restore in **PR 9**
- Commit `d468ac1` called `ApplyTimedPlaylist(..., session.WaitForVideoEnd)` with 5 params
- Used 4-param version; PR 9 adds the 5th param

---

## PR 3 — Undo Delete with Keybinds (`pr/undo-delete`)

### `mi:MaterialIcon` stripped from Undo button → restore in **PR 4 (Library UI)**
- Replaced `<mi:MaterialIcon Kind="Undo" Width="13" Height="13"/>` + StackPanel with plain `Undo` text
- PR 4 adds the Material Icons NuGet package (`MaterialDesign.Icons.Avalonia` or similar) and `xmlns:mi=` namespace
- Restore the icon + StackPanel layout when PR 4 base is available

### `Stop()` → `PlayerHelper.Stop()` in `ConfirmClearLibrary` → restore in **PR 4 or later**
- Upstream/main has no `Stop()` ViewModel method
- A later PR (likely Library UI or AutoMute) adds `[RelayCommand] private void Stop()` to ViewModel
- When that PR merges upstream, revert to `Stop()` call

### New AXAML elements use `StaticResource` palette refs → becomes `DynamicResource` when merged with **PR 1**
- Status bar Undo button area and new styles added by undo commits use `StaticResource` for palette colors
- PR 1 converts all existing refs to `DynamicResource`; PR 3's new refs will remain static until maintainer rebases
- Not a bug — just means those elements won't respond to theme changes until the rebase is done
- After PR 1 merges: rebase PR 3 and update any new `StaticResource` palette refs → `DynamicResource`

### `_currentlyPlayingCard` removed from delete loop → restore in **PR 2 or later**
- Commit `675ecaa` referenced `_currentlyPlayingCard` field which doesn't exist on upstream/main base
- Field is added by PR 2's `OnWallpaperChanged` callback pattern
- Maintainer merging PR 2 first then PR 3 will need to add this back, OR when rebasing PR 3 on top of merged PR 2, restore the line:
  `if (target == _currentlyPlayingCard) _currentlyPlayingCard = null;`

---

## PR 4 — Library UI Overhaul (`pr/library-ui-overhaul`)

### `VideoScaleOptions` / `_videoScale` / `OnVideoScaleChanged` excluded → owned by **PR 2**
- Commit `c0a4438` bundled `VideoScaleOptions = ["fit","fill"]` + `_videoScale = "fit"` + `OnVideoScaleChanged` alongside card layout options
- All excluded: `AppSettings.VideoScale` doesn't exist on upstream/main base
- PR 2 owns these; trivial merge conflict when both land

### `OnVolumeChanged` simplified → restore after **PR 2 merges**
- Full version checks `_currentlyPlayingCard?.VolumeOverride == null` before calling `SetVolume`, then loops `c.UpdateGlobalVolume(value)` over all cards
- Stripped to simple `Task.Run(() => PlayerHelper.SetVolume(value))` — no PR 2 fields available here
- Restore:
  ```csharp
  if (_currentlyPlayingCard?.VolumeOverride == null)
      Task.Run(() => PlayerHelper.SetVolume(value));
  foreach (var c in LibraryWallpapers)
      c.UpdateGlobalVolume(value);
  ```

### `OnSpeedChanged` absent → owned by **PR 2**
- Full handler references `SpeedOverride`, `UpdateGlobalSpeed`, `_settings.Speed` — all PR 2 additions
- Not included; PR 2 adds it

### `OnSceneCrashed` callback excluded from constructor → restore in **PR 10**
- Handler marks crashed scene card, removes from playlist if not whitelisted
- Excluded: scene feature not in this PR

### Stubs added (all in one fixup commit `2f044e3`) — replace when owning PR merges
| Stub | File | Owned by |
|------|------|----------|
| `WorkshopId string?` | `LibraryItem.cs` | PR 2 (LibraryService populates) |
| `AddedAt DateTime` | `LibraryItem.cs` | PR 2 (LibraryService sets `fi.CreationTime`) |
| `IsScene bool` | `WallpaperCardViewModel.cs` | PR 2 / PR 10 |
| `IsCurrentlyPlaying [ObservableProperty]` | `WallpaperCardViewModel.cs` | PR 2 also adds → trivial conflict |
| `OnWallpaperChanged Action<string?>?` | `PlayerHelper.cs` | PR 2 also adds → trivial conflict |

### PR 3 `Stop()` call — PR 4 adds the ViewModel `Stop()` method
- Check if PR 4's `f7d61fe` (Add Stop button to library header) adds `[RelayCommand] private void Stop()` to ViewModel
- If yes: PR 3's `PlayerHelper.Stop()` substitution can revert to `Stop()` after rebase

---

## PR 5 — GIF Thumbnails (`pr/gif-thumbnails`)

### `FindLibraryThumbnail` added to LibraryService → owned by **PR 2**, remove on merge
- PR 4 base `LibraryService.LoadAll()` only finds `.jpg` thumbnails
- Added `FindLibraryThumbnail()` from PR 2 to support `.png`/`.gif`/`.jpeg`
- Also removed hardcoded `jpg` variable from loop; now calls `FindLibraryThumbnail(media)`
- When PR 2 merges: `FindLibraryThumbnail` will already exist — trivial conflict, keep one copy

### PR 2 fields stripped from `WallpaperCardViewModel` LibraryItem constructor → restore after **PR 2 merges**
- Stripped from conflict in `4169abf`: `_hasCrashed`, `_isWhitelisted`, `_volumeOverride`, `_sliderVolume`, `_speedOverride`, `_sliderSpeed`
- Restore lines:
  ```csharp
  _hasCrashed = item.HasCrashed;
  _isWhitelisted = item.IsWhitelisted;
  _volumeOverride = item.VolumeOverride;
  _sliderVolume = item.VolumeOverride ?? 0;
  _speedOverride = item.SpeedOverride;
  _sliderSpeed = item.SpeedOverride ?? 1.0;
  ```

### `MakeLibraryCard` missing PR 2 wiring → restore after **PR 2 merges**
- Stripped from `4169abf` conflict: `OnVolumeChanged`, `UpdateGlobalVolume`, `OnSpeedChanged`, `UpdateGlobalSpeed`, `LoadDurationAsync`
- Restore:
  ```csharp
  card.OnVolumeChanged = (c, v) => SyncSelectedVolume(c, v);
  card.UpdateGlobalVolume(Volume);
  card.OnSpeedChanged = (c, v) => SyncSelectedSpeed(c, v);
  card.UpdateGlobalSpeed(Speed);
  card.LoadDurationAsync();
  ```

### WorkshopId copy button skipped (`3fe26a5`) → restore in **PR 6**
- Commit `3fe26a5` adds a copy button next to WorkshopId in preview modal
- Skipped: WorkshopId isn't displayed in preview modal on this base (PR 6 adds it via `fa8c235`)
- PR 6 cherry-pick will include both the display and copy button together

### Scene block stripped from `WallpaperEngineScraper.GetAllAsync` → restore in **PR 10**
- Scene detection (`isScene = ...`) and scene `results.Add` block stripped
- `allowScenes` parameter kept as harmless default false
- PR 10 restores the full scene handling

### Non-standard fixes (not in more-stuff, added for correct behavior on this base)
1. **`HorizontalContentAlignment/VerticalContentAlignment="Stretch"`** on Browse and Library thumbnail buttons
   - In more-stuff, Button sits inside a Panel which forces stretch; here Button is at Grid.Row directly
   - Without these, TemplatedControl content stays 0x0 → thumbnails invisible
   - If maintainer merges PR 4 before PR 5 and restructures card layout, may not be needed
2. **`LoadStaticThumbnailAsync` uses `WorkshopId ?? filename` as cache key**
   - Original: skips if `WorkshopId == null`; this branch never populates WorkshopId from LibraryService
   - Fix: fall back to `Path.GetFileNameWithoutExtension(gifPath)` as cache key
   - After PR 2 merges (LibraryService populates WorkshopId): consider reverting to WorkshopId-only to avoid cache key collisions

### Stubs added (fixup commit `1ab4fa0`)
| Stub | File | Owned by |
|------|------|----------|
| `IsScene bool` | `LibraryItem.cs` | PR 10 |
| `IsScene bool` | `WallpaperResult.cs` | PR 10 |
| `WorkshopId string?` | `WallpaperResult.cs` | PR 6/10 |
| `using Avalonia.Threading` | `WallpaperCardViewModel.cs` | needed for Dispatcher |

---

---

## PR 6 — WE Local Browse Search & Sort (`pr/we-local-browse`)

### `FindThumbnailAsync` → `FindThumbnail` in `WallpaperEngineScraper` → restore in **PR 5 merge**
- `fa8c235` used `FindThumbnailAsync` (from PR 5) to get `(thumbnail, animatedGif)` tuple
- On PR 6 base (no PR 5), replaced with sync `FindThumbnail(dir)` returning `string?`
- `AnimatedThumbnailUrl` omitted from results (not available without PR 5)
- After PR 5 merges: swap back to `await FindThumbnailAsync(dir)` and add `AnimatedThumbnailUrl = animatedGif` to both scene and video results

### `WallpaperResult.AddedAt` added → needed for sort options 5 and 6
- `fa8c235` adds `DateTime? AddedAt` to `WallpaperResult`
- PR 5 has `IsScene/WorkshopId` stubs — PR 6 adds `AddedAt` too
- On merge with PR 5: keep version that has all three (`IsScene`, `WorkshopId`, `AddedAt`)

### `WallpaperCardViewModel.WorkshopId` stub added → restore after **PR 2 merges**
- PR 6 fixup commit adds `WorkshopId` stub to support Workshop ID display in preview modal
- PR 5 also adds this stub → trivial conflict on merge, keep one version
- After PR 2: remove stub if PR 2 provides it from `LibraryItem`

### Preview modal volume/speed/crash sections stripped from `c9a0aa3` → restore after **PR 2 merges**
- `c9a0aa3` in more-stuff was written on top of PR 2 (which adds HasCrashed, IsWhitelisted, SliderVolume, SliderSpeed)
- Stripped `<!-- Crash warning -->`, `<!-- Per-wallpaper volume override -->`, `<!-- Per-wallpaper speed override -->` borders
- Also stripped `TextBox`-style selectable title (PR 11 feature) and `VideoDuration` display (PR 11)
- Kept only: `Grid.Row="1"` title StackPanel + WorkshopId TextBlock
- Restore full volume/speed/crash sections when PR 2 merges

### `fb5cc74` (ffmpeg ArgumentList fix) skipped on PR 6 → applied directly to **pr/gif-thumbnails**
- `fb5cc74` fixes `RunFfmpeg` to use `ArgumentList` instead of string arg (prevents path parsing breakage)
- PR 6 branch has no ffmpeg code (`ExtractGifStaticFrameAsync`/`RunFfmpeg` are PR 5 additions)
- Applied `fb5cc74` directly to `pr/gif-thumbnails` branch as a separate cherry-pick

---

## General Notes

- PRs 5, 6, 7 stack on PR 4 — they see the full Library UI including `mi:` namespace, so no stripping needed there
- PR 10 (Scene Support) will see trivial conflicts on `IsScene`/`WorkshopId` stubs in `WallpaperResult` and `LibraryItem` — accept incoming (scene PR populates them)
- PR 9 (Playlist Wait/Advance) will see `StartPlaylistObserver` already defined — keep existing impl, don't double-add
