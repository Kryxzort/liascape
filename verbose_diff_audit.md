# Verbose Diff Audit

**Scope**: Full git diff covering 29 changed files, 2 new files (new file entries), covering scene support, per-video overrides, theming, UI overhaul, and library management changes.

---

## ### File: README.md

#### Added section: Optional dependencies

- Lines 8–11: New `### Optional` subsection added before `## Installation`.
- Content: Documents `linux-wallpaperengine` as an optional dependency required for Wallpaper Engine **scene** support. Links to `https://github.com/Almamu/linux-wallpaperengine`. States it must be enabled in Settings → Sources → "Allow scene support".

#### Changed section: Wallpaper Engine source description

- Lines 19–24 (removed/added): Removed the old description limiting WE to "Video type only" with a note to filter by Video type in WE and a reference to `docs/we-video-type.png`.
- Replacement: Single line stating both Video wallpapers work out of the box and Scene wallpapers require linux-wallpaperengine with a settings toggle.
- The image reference `docs/we-video-type.png` is removed entirely.

---

## ### File: src/livepaper/App.axaml

#### New XML namespace

- Line 35: Added `xmlns:mi="clr-namespace:Material.Icons.Avalonia;assembly=Material.Icons.Avalonia"` — imports Material Icons Avalonia namespace for use of `<mi:MaterialIcon>` throughout the UI.

#### New resource brush entries

- `AccentHover` (`#a8c7ff`): Added as a named resource. Previously this color was hardcoded inline in the `Button.accent:pointerover` style.
- `DangerBg` (`#3d1f24`): Added as a named resource. Previously hardcoded in `Button.danger:pointerover`.
- `Success` (`#a6e3a1`): New color, used for the "currently playing" border on library cards.
- ScrollBar override brushes: `ScrollBarTrackFill`, `ScrollBarTrackFillPointerOver`, `ScrollBarBackground`, `ScrollBarBackgroundPointerOver` — all set to `Transparent`. These suppress Avalonia's default scrollbar track/background styling.

#### StaticResource → DynamicResource conversion (pervasive)

- Every `StaticResource` reference for themed colors (`BgMantle`, `BgBase`, `Surface0`, `Surface1`, `TextColor`, `Accent`, `AccentFg`, `Danger`, `Subtext`, `Muted`, `AccentFg`) is changed to `DynamicResource`. This is the prerequisite for runtime theme switching: `StaticResource` resolves once at load time, `DynamicResource` re-resolves when the resource dictionary value changes.
- Applies to: Window, Button (all variants), TextBox, ComboBox, NumericUpDown, ListBox.pills, TabItem, CheckBox, ScrollBar.

#### Added: Material Icons styles

- `<mi:MaterialIconStyles />` added inside `<Application.Styles>`. Required to register Material Icons fonts.

#### Added: Button transition + press animation

- `Button` base style gains a `Transitions` block: `TransformOperationsTransition` on `RenderTransform` with duration `0:0:0.065`.
- New `Button:pressed` style: `RenderTransform` set to `scale(0.96)`. Provides tactile press feedback on all buttons.

#### Changed: Button.accent hover

- Old: `Background` hardcoded to `#a8c7ff` inline.
- New: `Background` bound to `{DynamicResource AccentHover}` — now theme-aware.

#### Changed: Button.ghost

- `Button.ghost:pointerover` gains `Foreground` set to `{DynamicResource TextColor}` (was absent; pointer-over now brightens text).
- New `Button.ghost:pressed` style: `Background` set to `{DynamicResource Surface1}` for a pressed state distinct from hover.

#### Changed: TabItem padding

- `TabItem` `Padding` changed from `18,12` to `18,8` — reduces tab bar height.

#### Added: Custom ScrollBar styles (extensive)

A complete custom scrollbar appearance is introduced:

- `ScrollBar /template/ Rectangle#TrackRect`: `Fill` set to `Transparent` — removes the track rectangle.
- `ScrollBar:vertical`: `Width` and `MinWidth` set to `10`.
- `ScrollBar:horizontal`: `Height` and `MinHeight` set to `10`.
- `ScrollBar /template/ RepeatButton#PART_LineUpButton`, `PART_LineDownButton`, `PART_PageUpButton`, `PART_PageDownButton`: All set `IsVisible=False` — removes arrow buttons and page-click zones, leaving only the thumb.
- `ScrollBar Thumb`: `Background` = `{DynamicResource Surface1}`, `CornerRadius` = `10`, animated transitions on `Width`, `Height`, `Background` with `0:0:0.1` duration.
- `ScrollBar:vertical Thumb`: `MinWidth`=6, `MinHeight`=20, `Width`=6, `Margin`=`2,0`.
- `ScrollBar:horizontal Thumb`: `MinWidth`=20, `MinHeight`=6, `Height`=6, `Margin`=`0,2`.
- `ScrollBar:vertical:pointerover Thumb`: `Background`=`Surface2`, `Width`=8, `Margin`=`1,0` — thumb expands on hover.
- `ScrollBar:horizontal:pointerover Thumb`: same pattern for horizontal.
- `ScrollBar:pressed Thumb`: `Background`=`{DynamicResource Muted}`.

#### Added: Library card hover outline animation

- `Border Border.library-hover-outline`: `Opacity`=0 with a `DoubleTransition` on `Opacity` at `0:0:0.15`.
- `Border:pointerover Border.library-hover-outline`: `Opacity`=0.5.
- This makes the accent-colored card border fade in on hover in both Browse and Library grids.

---

## ### File: src/livepaper/App.axaml.cs

#### New using

- `using livepaper.Models;` added — needed to reference `ThemeService` types.

#### Changed: `Initialize()` method

- After `AvaloniaXamlLoader.Load(this)`, two new lines are added:
  ```csharp
  var settings = SettingsService.Load();
  ThemeService.Apply(ThemeService.Find(settings.Theme) ?? ThemeService.Default);
  ```
- Effect: The persisted theme is applied at application startup before any window is displayed.

#### Changed: `OnFrameworkInitializationCompleted()` — playlist daemon respawn

- Added else-if branch for non-timed playlists:
  ```csharp
  else if (settings.LastSession?.IsPlaylist == true && PlayerHelper.IsPlaying)
      PlayerHelper.SpawnTimerDaemon();
  ```
- Previously only `IsTimedPlaylist` respawned the daemon. Now non-timed playlists (advance-on-end) also respawn the timer daemon so per-video volume/speed overrides survive GUI restart.

---

## ### File: src/livepaper/Helpers/AudioMonitor.cs

#### New public property

- `public static bool IsMuted => _isMuted;` — exposes the current mute state so `PlayerHelper` can read it when setting LWE audio on launch.

#### New private field

- `private static bool _onlyIfMprisActive;` — gate for conditional auto-mute.

#### Changed: `RunDaemon()`

- Passes `settings.AutoMuteOnlyIfMprisActive` as a new argument to `Start()`.

#### Changed: `Start()` signature

- Before: `public static void Start(int muteDelayMs, int unmuteDelayMs, double thresholdDb)`
- After: `public static void Start(int muteDelayMs, int unmuteDelayMs, double thresholdDb, bool onlyIfMprisActive = false)`
- Assigns `_onlyIfMprisActive = onlyIfMprisActive` at the top of `Stop()`/re-init sequence.

#### Changed: Auto-mute trigger logic (main monitoring loop)

- Old: `PlayerHelper.SetMute(true); _isMuted = true;` called unconditionally when audio threshold exceeded.
- New: Wrapped in:
  ```csharp
  if (!_onlyIfMprisActive || IsAnyMprisPlayerActive())
  {
      PlayerHelper.SetMute(true);
      _isMuted = true;
  }
  ```
- Effect: When `_onlyIfMprisActive` is true, the wallpaper is muted only if a MPRIS media player is currently playing.

#### New method: `IsAnyMprisPlayerActive()`

- Uses `playerctl status` to check if any MPRIS player reports "Playing".
- Runs `playerctl status`, reads stdout, waits up to 500ms for exit, returns `true` if output equals "Playing" (case-insensitive).
- Returns `false` on any exception.

#### Changed: `GetNonMpvStreamIdsAsync()` — exclude SDL Application streams

- Added filter: `if (block.Contains("application.name = \"SDL Application\"")) continue;`
- Rationale: `linux-wallpaperengine` uses SDL, which creates sink inputs with `application.name = "SDL Application"`. Without this, LWE audio streams would trigger auto-mute.

---

## ### File: src/livepaper/Helpers/DownloadHelper.cs

#### Changed: `DownloadAsync()` — scene handling branch

- New early-return block for `detail.IsScene`:
  - Writes a `.scene` file at `LibraryPath/<safeTitle>.scene` containing `detail.WorkshopId ?? Path.GetFileName(detail.DownloadUrl)`.
  - Calls new `SaveThumbnailAsync()` helper to download/copy the thumbnail.
  - Writes a `.id` sidecar if `sourceId` is provided.
  - Returns a `LibraryItem` with `IsScene = true`, `WorkshopId = detail.WorkshopId`, and `AddedAt = DateTime.Now`.
  - No video file is downloaded for scenes — only the workshop ID is persisted.

#### Changed: `DownloadAsync()` — thumbnail handling for video path

- Renamed `thumbPath` to `thumbPathVideo` to scope it clearly to the non-scene path.
- Thumbnail extension now detected dynamically: `string thumbExt = Path.GetExtension(thumbnailUrl); if (string.IsNullOrEmpty(thumbExt)) thumbExt = ".jpg";`
- Old code assumed `.jpg` extension always.
- `WorkshopId = detail.WorkshopId` and `AddedAt = System.DateTime.Now` added to returned `LibraryItem`.

#### New method: `SaveThumbnailAsync(string? thumbnailUrl, string safeTitle, bool copyLocalFiles)`

- Encapsulates thumbnail download/copy logic for scene items.
- Detects extension from URL (falls back to `.jpg`).
- Handles local files (copy or symlink based on `copyLocalFiles`) and remote URLs (HTTP download).
- Returns the local thumbnail path on success, `null` on failure.

---

## ### File: src/livepaper/Helpers/LibraryService.cs

#### New using

- `using System;` added for `DateTime` and `Globalization` access.

#### New property: `TrashPath`

- `public static string TrashPath => Path.Combine(DownloadHelper.LibraryPath, ".trash");`
- Defines the staging directory for soft-deleted items.

#### New method: `Trash(LibraryItem item, string batchDir)`

- Moves video file, thumbnail, and all known sidecars (`.jpg`, `.png`, `.gif`, `.jpeg`, `.id`, `.crashed`, `.whitelist`, `.volume`, `.speed`) to `batchDir` using `MoveIfExists()`.
- Called instead of `Delete()` when the user deletes items — enables undo.

#### New method: `RestoreBatch(string batchDir)`

- Moves all files from `batchDir` back to `LibraryPath`.
- Deletes `batchDir` on completion.

#### New method: `PurgeBatch(string batchDir)`

- `Directory.Delete(batchDir, recursive: true)` — permanently removes a trash batch.

#### New method: `CleanTrash()`

- Iterates `TrashPath` subdirectories and deletes each. Called at startup to purge any leftover trash from a previous session that was not committed to undo.

#### New private method: `MoveIfExists(string src, string destDir)`

- Moves `src` to `destDir/filename` if it exists. Used by `Trash()`.

#### Changed: `Delete(LibraryItem item)`

- Old: Deleted video, thumbnail, and only `.id` sidecar.
- New: Deletes video, thumbnail, and all sidecars: `.jpg`, `.png`, `.gif`, `.jpeg` (thumbnail variants) plus `.id`, `.crashed`, `.whitelist`, `.volume`, `.speed` (metadata sidecars).

#### New method: `MarkCrashed(string videoPath)`

- Writes an empty `.crashed` sidecar file. Called when a scene crashes during playback.

#### New method: `SaveVolumeOverride(string videoPath, int? volume)`

- Writes `volume.ToString()` to `.volume` sidecar, or deletes it if `volume` is null.

#### New method: `SaveSpeedOverride(string videoPath, double? speed)`

- Writes speed to `.speed` sidecar using `InvariantCulture`, or deletes it if null.

#### New method: `SetWhitelisted(string videoPath, bool whitelisted)`

- Creates or deletes `.whitelist` sidecar. Whitelisted scenes stay in the playlist even after crashing.

#### Changed: `LoadAll()` — media file discovery

- PNG exclusion: `.png` files are now excluded if a sibling `.scene` or `.mp4` file exists. This prevents scene thumbnails from appearing as standalone wallpapers.
- Comment updated to document this logic.
- Existing `.mp4` loop now reads additional sidecar state for each media item:
  - `workshopId` via `ParseWorkshopId()`
  - `hasCrashed` (`File.Exists(*.crashed)`)
  - `isWhitelisted` (`File.Exists(*.whitelist)`)
  - `volumeOverride` via `ReadVolumeOverride()`
  - `speedOverride` via `ReadSpeedOverride()`
  - `AddedAt = fi.CreationTime`
- These populate corresponding new `LibraryItem` fields.

#### New: Scene file loading loop in `LoadAll()`

- Iterates `*.scene` files in `LibraryPath`.
- For each: reads `workshopId` from file content, reads sidecars, populates `LibraryItem` with `IsScene = true`.
- Scene items appear in the library alongside video items.

#### New private method: `FindLibraryThumbnail(string mediaPath)`

- Searches for thumbnail files with the same base name but extensions `.jpg`, `.png`, `.gif`, `.jpeg`.
- Returns first match, or null.
- Replaces the previous hardcoded `.jpg`-only lookup.

#### New private method: `ParseWorkshopId(string? sourceId, string mp4, string idFile)`

- Converts a stored source ID (which may be a local path like `~/.local/share/Steam/steamapps/workshop/content/431960/<id>/`) into a numeric workshop ID.
- Logic:
  1. If `sourceId` is purely numeric, returns it directly.
  2. If it starts with `http`, returns null (remote URL, not a workshop path).
  3. Splits on `Path.DirectorySeparatorChar`, looks for segment `431960` or `workshop` followed by a numeric segment, extracts the numeric ID and rewrites `.id` file.
  4. Fallback: any purely numeric segment with 8+ digits.
- This normalizes old `.id` files that contained full Steam paths.

#### New private method: `ReadVolumeOverride(string mediaPath)`

- Reads `.volume` sidecar, parses as int. Returns null on failure or absence.

#### New private method: `ReadSpeedOverride(string mediaPath)`

- Reads `.speed` sidecar, parses as double with `InvariantCulture`. Returns null on failure or absence.

---

## ### File: src/livepaper/Helpers/MonitorDetector.cs (new file)

**Purpose**: Detects connected monitor names from the compositor (Hyprland or Sway) for pre-populating the LWE monitor list.

#### `DetectAsync()` (public static)

- Tries `hyprctl monitors -j` first, then `swaymsg -t get_outputs`.
- Returns `List<string>` of monitor names, or empty list if neither succeeds.

#### `TryAsync(string cmd, string args, Func<string, List<string>?> parse)` (private static)

- Spawns the compositor command, captures stdout, waits for exit.
- Returns null if exit code != 0 or on exception.

#### `ParseHyprctl(string json)` (private static)

- Deserializes JSON array, extracts `name` property from each element.
- Returns list only if non-empty.

#### `ParseSwaymsg(string json)` (private static)

- Same structure as `ParseHyprctl` — both Hyprland and Sway return compatible JSON for monitor names.

---

## ### File: src/livepaper/Helpers/PlayerHelper.cs (major, ~1382 line changes)

#### New using

- `using System.Threading.Tasks;` added.

#### New private fields

```csharp
private static CancellationTokenSource? _observerCts;      // playlist-pos IPC observer
private static bool _waitForVideoEnd;                       // interval mode: wait for current video to finish before switching
private static bool _waitingForVideoEnd;                    // true while DoVideoEndWait is in-flight
private static bool _advanceOnVideoEnd;                     // true when running scene-aware advance-on-end
private static double _currentSpeed = 1.0;                 // tracks live playback speed for timer scaling
private static CancellationTokenSource? _waitCts;          // cancels in-flight DoVideoEndWait
private static CancellationTokenSource? _prelaunchCts;     // cancels in-flight pre-launch transition
private static bool _isMuted;                              // current mute state (automute + user)
private static bool _userMuted;                            // set by user action; blocks automute from unmuting
private static volatile TaskCompletionSource<bool>? _speedChangeTcs; // wakes DoVideoEndWait sleep on speed change
```

#### Changed: `IsPlaying` property

- Old: `File.Exists(IpcSocket) && Process.GetProcessesByName("mpvpaper").Length > 0`
- New: `(File.Exists(IpcSocket) && Process.GetProcessesByName("mpvpaper").Length > 0) || IsLweRunning`
- Scene playback (LWE) is now counted as "playing".

#### New property: `IsLweRunning` (private getter)

- Reads `LwePidPath`, parses each line as a PID, checks `Process.GetProcessById(pid).HasExited`.
- Returns true if any listed PID is still alive.

#### New property: `IsTimedModeActive`

- `public static bool IsTimedModeActive { get { lock (_lock) { return _timedPaths != null; } } }`
- Exposes whether the timed playlist engine is currently running. Used by `MainWindowViewModel` to detect mixed-playlist upgrades.

#### New property: `IsUserMuted`

- `public static bool IsUserMuted => _userMuted;`
- Exposes user-initiated mute state for CLI toggle-mute logic.

#### New path constants

- `PlaylistObserverPathsPath`: `~/.cache/livepaper/playlist_observer_paths.json` — persists the shuffled path order for playlist observer reconnection.
- `LwePidPath`: `~/.config/livepaper/lwe.pid` — stores PIDs of running linux-wallpaperengine processes.
- `UserMuteStatePath`: `~/.config/livepaper/user_mute.state` — file presence = user muted.

#### Changed: `TimedState` record

- Added `bool WaitForVideoEnd = false` parameter. Persists the "wait for video end" mode across daemon restarts.

#### Changed: `SaveTimedState()`

- Now serializes `_waitForVideoEnd` into the state JSON.

#### Changed: `RefreshTimedState()` (was existing)

- Added block to sync `_userMuted` and `_isMuted` from `UserMuteStatePath` file existence. This allows CLI `toggle-mute` to affect the running daemon without an IPC connection.

#### New method: `LoadUserMuteState()`

- Reads `UserMuteStatePath` existence into `_userMuted` and `_isMuted`. Called at program startup.

#### Changed: `LoadTimedState()`

- Assigns `_waitForVideoEnd = state.WaitForVideoEnd` when restoring state.

#### Changed: `Apply(string videoPath, string mpvOptions)`

- Added scene validation before applying:
  ```csharp
  if (IsScenePath(videoPath))
  {
      if (!s.AllowScenes) throw new InvalidOperationException("...");
      if (!IsLweAvailable()) throw new InvalidOperationException("...");
  }
  ```
- Errors surface to the UI via the error modal.

#### Changed: `ApplyPlaylist()` signature

- Added `int intervalSeconds = 0` parameter.
- New logic at the top: if `shuffle`, pre-shuffle paths via `Guid.NewGuid()`.
- Scene detection: if `settings.AllowScenes && IsLweAvailable() && paths.Any(IsScenePath)`, upgrades to `ApplyTimedPlaylist()` with `waitForVideoEnd: true, advanceOnVideoEnd: true` and returns early. Mixed playlists (video + scene) always use the timed machinery.
- Filters out scene paths if scenes are not allowed/available.
- Removed `--shuffle` flag from mpvpaper args (shuffle is now pre-applied to path array).
- After launch, calls `StartPlaylistObserver(paths)` and writes `PlaylistObserverPathsPath`.

#### Changed: `ApplyTimedPlaylist()` signature

- Added `bool waitForVideoEnd = false, bool advanceOnVideoEnd = false`.
- Sets `_waitForVideoEnd`, `_advanceOnVideoEnd`, `_currentSpeed = SettingsService.Load().Speed`.
- After switching to `ordered[0]`, if `_advanceOnVideoEnd` and the first item is not a scene and there are more items: pre-fetches next via `AdvanceToNext()`, starts `DoVideoEndWait(next, cts.Token, prevIsVideo: true)`.

#### Changed: `TimerTick()` (existing method)

**New: Scene crash detection**:
- Before processing the timer, checks if current history item is a scene path that has no running LWE and is not being waited on. If so: calls `OnSceneCrashed?.Invoke(path)` and sets `_timedRemainingMs = 0` to advance immediately.

**New: Speed-scaled timer countdown**:
- Old: `_timedRemainingMs -= elapsedMs`
- New: `_timedRemainingMs -= (long)(elapsedMs * speedFactor)` where `speedFactor = IsLweRunning ? 1.0 : _currentSpeed`. Scenes always count at 1× (LWE doesn't support speed changes).
- The countdown only runs when `!_waitingForVideoEnd && (!_advanceOnVideoEnd || IsLweRunning)`.

**New: WaitForVideoEnd branching**:
- When `_timedRemainingMs <= 0` and `_waitForVideoEnd`, calls `AdvanceToNext()` and starts `DoVideoEndWait(next, cts.Token)` rather than calling `AdvanceAndLaunch()` directly.

#### Changed: `LaunchAndReset(string path)`

- Old: `SwitchToFile(path, _timedOptions); _timedRemainingMs = ...`
- New: Uses `SettingsService.Load().BuildMpvOptions()` instead of stale `_timedOptions`.
- If `_advanceOnVideoEnd` and path is not a scene: pre-fetches next, starts `DoVideoEndWait`, sets `_waitingForVideoEnd = true`.
- Otherwise: resets `_timedRemainingMs`.

#### Changed: `SwitchToFile(string path, string mpvOptions)` — scene-aware transition

Old logic: IPC switch if mpv alive, otherwise kill and launch.

New logic introduces three cases:

**Case 1 — Next is a scene (video→scene or scene→scene)**:
1. Validates `AllowScenes` and `IsLweAvailable`.
2. Reads `workshopId` from `.scene` file.
3. Captures old mpvpaper processes and old LWE PIDs.
4. Calls `SpawnLweProcesses(workshopId, settings)` — starts new LWE instances.
5. Fires `OnWallpaperChanged?.Invoke(path)`.
6. Polls for LWE PulseAudio sink inputs to appear (up to 3 seconds, 50ms intervals), then applies mute and volume.
7. After `SceneTransitionDelayMs` delay (async, cancellable via `_prelaunchCts`), kills old mpvpaper processes and old LWE PIDs.

**Case 2 — Prev is a scene, next is a video (scene→video)**:
1. Reads old LWE PIDs.
2. Calls `KillMpvPaperOnly()` to clear any stray mpvpaper.
3. Launches new mpvpaper with a `TaskCompletionSource<bool> readyTcs`.
4. `Launch()` now accepts `readyTcs`; its `OutputDataReceived` handler fires `readyTcs.TrySetResult(true)` when an `AV:` or `V:` line appears.
5. Fires `OnWallpaperChanged?.Invoke(path)`.
6. Applies volume/speed/mute overrides.
7. Async task waits for `readyTcs` (max 3s), then kills old LWE PIDs and deletes `LwePidPath`.

**Case 3 — Video→video (existing path)**:
- Checks `bool mpvAlive = File.Exists(IpcSocket) && Process.GetProcessesByName("mpvpaper").Length > 0`.
- On IPC switch success: fires `OnWallpaperChanged`, applies per-video volume/speed overrides.
- On cold start: bakes overrides into options via `BakeVolumeOverride` and `BakeSpeedOverride`, applies mute if needed.

**Cancellation**: At start of `SwitchToFile`, cancels any in-flight `_prelaunchCts`.

#### New method: `TryQueryCurrentPath()`

- Opens mpv IPC socket, sends `get_property path`, reads response.
- Returns the currently playing file path or null.

#### New method: `SwitchFromTimedToAdvanceOnEnd(IReadOnlyList<string> allPaths, bool shuffle)`

- Converts running timed-interval playlist to advance-on-end without restarting mpvpaper.
- Tears down timer, clears timed state.
- Sends IPC commands: `set loop-file no`, `loadfile <path> append` for each remaining path, `set loop-playlist inf`.

#### New method: `SwitchFromAdvanceOnEndToTimed(IReadOnlyList<string> allPaths, string mpvOptions, bool shuffle, int intervalSeconds, bool waitForVideoEnd)`

- Converts advance-on-end back to timed-interval without restarting mpvpaper.
- Sends IPC `set loop-file inf`, `playlist-clear`, `set loop-playlist no`.
- Re-initializes all timed state fields.
- Tries to preserve the currently playing item as anchor (via `TryQueryCurrentPath()`).

#### New method: `ReorderPlaylist(IReadOnlyList<string> originalPaths, bool isTimedPlaylist, bool shuffle)`

- Reorders the active playlist in real time without restarting mpvpaper.
- **Timed mode**: Updates `_timedPaths`, `_timedIndex`, `_history`, `_historyIndex`. Preserves `_timedRemainingMs`. If `_advanceOnVideoEnd`, cancels in-flight `DoVideoEndWait` and re-arms from current position.
- **Advance-on-end mode**: Queries current path via IPC, clears mpv playlist, appends rest in new order.
- Handles the case where the current item is not in the new list (was removed).
- Pre-fetch offset: when `_waitingForVideoEnd`, `_historyIndex` is one step ahead, so uses `_historyIndex - 1` as the playing item.

#### New method: `SyncAdvanceOnEndPlaylist(IReadOnlyList<string> oldPaths, IReadOnlyList<string> newPaths, bool shuffle)`

- Syncs mpv's native playlist when items are added/removed from the playlist panel.
- **Optimized add-only path**: If no shuffle, only additions, and existing items in same order — just appends new items to mpv queue.
- **Full rebuild**: All other cases (removes, reorders, shuffle) — clears mpv playlist and rebuilds from current position.
- Delegates to `ReorderPlaylist()` for mixed (timed + scene) playlists.

#### New method: `TryQueryTimeRemaining()`

- Queries `playtime-remaining` property via IPC (not `time-remaining`, to correctly account for speed).
- Returns double seconds or null.

#### New method: `DoVideoEndWait(string next, CancellationToken ct, bool prevIsVideo = false)` (private async)

Handles seamless transition at the end of a video. Three sub-cases:

**Video→video**:
- Queries `playtime-remaining` with retry (up to 5s if `_advanceOnVideoEnd`).
- Sends `set loop-file no`, `loadfile next append`.
- Enters sleep loop respecting speed changes via `_speedChangeTcs`: sleeps for `rem2 * 1000ms`, wakes early if speed changes, re-queries remaining.
- After sleep, applies next video's volume/speed overrides.
- 300ms buffer to let mpv complete the A→B advance.
- In lock: sets `loop-file` (per settings), clears playlist, fires `OnWallpaperChanged`.
- If still in advance-on-end mode: pre-fetches next-next, chains another `DoVideoEndWait`.

**Video→scene**:
- Queries `playtime-remaining` with retry.
- Enters sleep loop: `sleepMs = max(0, rem2 * 1000 - SceneTransitionDelayMs)` — starts LWE `SceneTransitionDelayMs` before video ends.
- Same speed-change wake logic.
- Falls through to the scene-launch block below.

**Scene→video and scene→scene** (LWE has no IPC):
- Switches immediately via `SwitchToFile()`.

#### New method: `CancelVideoEndWait()`

- Cancels `_waitCts`, clears `_waitingForVideoEnd`.
- Sends `set loop-file inf` to prevent mpv from advancing to the queued file in the cancellation gap.

#### Changed: `AdvanceAndLaunch()`

- When `_waitingForVideoEnd` is true (pre-fetched mode), uses `_history[_historyIndex]` directly instead of calling `AdvanceToNext()` again.
- Calls `CancelVideoEndWait()` before proceeding.

#### Changed: `StepBackAndLaunch()`

- When `_waitingForVideoEnd`, performs double decrement: first undo pre-fetch, then go to actual previous.
- Calls `CancelVideoEndWait()`.

#### Changed: `RandomAndLaunch()`

- When `_waitingForVideoEnd`, uses `_historyIndex - 1` as the "current" to exclude from random pick.
- Calls `CancelVideoEndWait()`.

#### Changed: `AdvanceToNext()`

- Wrapped in a `for (int attempt = 0; attempt < p.Count; attempt++)` loop.
- Each iteration calls `IsSkippedPath(path)`; if skipped, continues to the next.
- Returns null if all paths are skipped (e.g., all scenes and scenes are disabled).

#### Changed: `Launch()` signature

- Added `TaskCompletionSource<bool>? readyTcs = null`.
- `OutputDataReceived` handler now checks for `AV:` or `V:` lines and fires `readyTcs.TrySetResult(true)`.

#### Changed: `KillCurrentProcess()`

- After killing mpvpaper processes: calls `StopPlaylistObserver()` and `KillLweProcess()`.

#### New method: `KillLweProcess()`

- Reads PIDs from `LwePidPath`, kills each process with `entireProcessTree: true`.
- Deletes `LwePidPath`.
- Also calls `Process.GetProcessesByName("linux-wallpaperengine")` as a safety net to kill any orphaned LWE processes.

#### New method: `ClearPlaylistObserverPaths()`

- Deletes `PlaylistObserverPathsPath`.

#### Changed: `TeardownTimer()`

- Now also cancels `_waitCts`, `_prelaunchCts`, and resets `_waitingForVideoEnd`, `_advanceOnVideoEnd`.

#### Changed: `Stop()`

- Calls `ClearPlaylistObserverPaths()` after `KillAll()`.

#### Changed: `Restore()`

- Before restoring session: if `settings.AutoMute`, calls `AudioMonitor.SpawnDetachedMonitor()` to restart the audio monitor daemon.
- For `IsPlaylist` sessions (advance-on-end): now also calls `SpawnTimerDaemon()` — needed so per-video overrides are applied via `ObservePathAsync`.

#### Changed: `SpawnTimerDaemon()`

- Old: Only handled `IsTimedPlaylist`.
- New: Handles `IsTimedPlaylist`, `IsPlaylist` (reconnects observer), or returns for other cases.
- For `IsPlaylist`: loads saved observer paths from `PlaylistObserverPathsPath` (to use correct shuffled order), calls `StartPlaylistObserver(observerPaths)`.

#### Changed: `SetMute(bool mute)` — automute-driven

- Old: single `SendCommand("set_property", "mute", mute)`.
- New: If `!mute && (_userMuted || File.Exists(UserMuteStatePath))` — returns without unmuting. Automute cannot override user-initiated mute.
- Sets `_isMuted = mute`.
- Calls `ApplyLweMute(mute)` if LWE is running.

#### New method: `SetUserMute(bool mute)`

- Sets `_userMuted = mute`, `_isMuted = mute`.
- Writes or deletes `UserMuteStatePath` file.
- Calls `SendCommand("set_property", "mute", mute)` and `ApplyLweMute(mute)`.

#### Changed: `SetVolume(int volume)`

- Old: single `SendCommand`.
- New: Also calls `ApplyLweVolume(volume)` if LWE is running.

#### New method: `SetSpeed(double speed)`

- Sends `set_property speed` IPC command.
- Updates `_currentSpeed` under lock.
- Signals `_speedChangeTcs.TrySetResult(true)` to wake sleeping `DoVideoEndWait`.

#### New method: `SetLoop(bool loop)`

- Sends `set loop-file inf` or `no`.

#### New method: `SetPlaylistShuffle(bool shuffle)`

- Sends `playlist-shuffle` or `playlist-unshuffle` IPC command.

#### New method: `StartPlaylistObserver(IReadOnlyList<string> videoPaths)`

- Cancels existing `_observerCts`, creates new one, starts `ObservePathAsync` task.

#### New method: `StopPlaylistObserver()`

- Cancels and disposes `_observerCts`.

#### New method: `ObservePathAsync(string[] videoPaths, CancellationToken ct)` (private async)

- Waits up to 5s for the IPC socket to exist.
- Opens a persistent IPC connection.
- Sends `observe_property 1 playlist-pos`.
- Reads lines in a loop; on `property-change` for `playlist-pos`, calls `ApplyOverridesForPath(videoPaths[pos])` and fires `OnWallpaperChanged`.

#### New method: `ApplyOverridesForPath(string path)`

- Reads per-video volume and speed overrides, falls back to global settings, calls `SetVolume` and `SetSpeed`.

#### New method: `SetVideoScale(string scale)`

- Sends `set_property panscan 1.0` (fill) or `0.0` (fit) via IPC.

#### Changed: `UpdateTimedSettings()` signature

- Added `bool waitForVideoEnd = false, bool advanceOnVideoEnd = false`.
- Timer interval change now preserves elapsed time: `_timedRemainingMs = elapsed >= newIntervalMs ? newIntervalMs : newIntervalMs - elapsed;`
- Handles mode transitions (`advanceOnVideoEnd` toggling): cancels in-flight `DoVideoEndWait`, re-arms if needed.

#### New method: `IsLweAvailable()` (public)

- Runs `which linux-wallpaperengine`, returns true if exit code 0.

#### New method: `IsScenePath(string path)` (public)

- Returns `path.EndsWith(".scene", StringComparison.OrdinalIgnoreCase)`.

#### New method: `IsSkippedPath(string path)` (private)

- Returns true if path is a scene and scenes are not allowed/available.

#### New method: `SpawnLweProcesses(string workshopId, AppSettings settings)` (private)

- Spawns one `linux-wallpaperengine` process per configured monitor.
- Uses `setsid` to detach from terminal.
- Arguments: `--noautomute --screen-root <name>`.
- Audio: `--silent` if `settings.NoAudio` or monitor is not primary; else `--volume 100`.
- FPS: `--fps <n>` if `monitor.Fps > 0`.
- Always adds `--no-fullscreen-pause`.
- Writes spawned PIDs to `LwePidPath`.
- Returns array of PID strings.

#### New method: `LaunchScene(string workshopId, AppSettings settings)` (private)

- Kills existing LWE, calls `SpawnLweProcesses`, returns count. (Helper not currently called directly by public API; used internally.)

#### New method: `ReadCurrentLwePids()` (private)

- Reads `LwePidPath` and returns string array of PID lines.

#### New method: `KillPids(string[] pids)` (private)

- Kills each PID by integer value via `Process.GetProcessById(pid).Kill(entireProcessTree: true)`.

#### New method: `KillMpvPaperOnly()` (private)

- Kills all `mpvpaper` processes without touching LWE. Used in scene→video pre-launch to keep LWE alive during mpvpaper startup.

#### New method: `GetLweSinkInputIds()` (private)

- Runs `pactl list sink-inputs`, parses output.
- Returns list of PulseAudio sink-input IDs belonging to `application.name = "SDL Application"` (LWE's signature).

#### New method: `ApplyLweVolume(int volume)` (private)

- Gets LWE sink input IDs, runs `pactl set-sink-input-volume <id> <volume>%` for each.

#### New method: `ApplyLweMute(bool mute)` (private)

- Gets LWE sink input IDs, runs `pactl set-sink-input-mute <id> 1/0` for each.

#### New method: `RunPactl(string args)` (private)

- Generic pactl command runner. Fire-and-forget with exception swallowing.

#### New private methods: `ReadVolumeOverride`, `ReadSpeedOverride` (private)

- Duplicated from `LibraryService` for use within `PlayerHelper` where `LibraryItem` is not available (only path is known).

#### New method: `BakeVolumeOverride(string options, string path)` (private)

- If a `.volume` sidecar exists, replaces or appends `--volume=N` in the mpv options string.
- Does not modify options if `--no-audio` is present.

#### New method: `BakeSpeedOverride(string options, string path)` (private)

- If a `.speed` sidecar exists, replaces or appends `--speed=N` in the mpv options string.

#### New static actions

- `public static Action<string?>? OnWallpaperChanged;` — fired on every wallpaper transition with the new path (null on stop).
- `public static Action<string>? OnSceneCrashed;` — fired when a scene is detected as having crashed.

---

## ### File: src/livepaper/Helpers/ThemeService.cs (new file, 279 lines)

**Purpose**: Runtime theme management. Defines all built-in themes and applies them to Avalonia's resource dictionary.

#### `All` property

- `IReadOnlyList<AppTheme>` containing 31 named themes across 12 theme families:
  - Catppuccin: Mocha, Macchiato, Frappé, Latte
  - Dracula
  - Nord
  - Tokyo Night: Night, Storm, Day
  - Gruvbox: Dark, Light
  - One Dark
  - Solarized: Dark, Light
  - Rosé Pine: base, Moon, Dawn
  - Everforest: Dark, Light
  - Kanagawa: Wave, Dragon, Lotus
  - Ayu: Dark, Mirage, Light
  - Poimandres
  - Monokai
  - Material: Dark, Ocean
  - Synthwave
  - Cyberdream
  - Oxocarbon

Each theme is constructed via `AppTheme` record with 15 color parameters (BgBase, BgMantle, BgCrust, Surface0–2, TextColor, Subtext, Muted, Accent, AccentFg, AccentHover, Danger, DangerBg, Success).

#### `Default` property

- Returns `All[0]` (Catppuccin Mocha).

#### `Find(string name)` method

- `All.FirstOrDefault(t => t.Name == name)`.

#### `Apply(AppTheme theme)` method

- Sets all 15 color keys in `Application.Current.Resources` by parsing hex strings via `Color.Parse()` and wrapping in `SolidColorBrush`.
- Operates on the live resource dictionary, so `DynamicResource` bindings update immediately.

---

## ### File: src/livepaper/Models/AppSettings.cs

#### New fields

- `VideoScale`: `string`, default `"fill"`. Controls panscan behavior (fill vs fit). "fill" → panscan=1.0, anything else → panscan=0.0.
- `Speed`: `double` with backing field `_speed`, clamped 0.1–4.0, default 1.0.
- `AllowScenes`: `bool`, default `false`. Gate for scene support.
- `LweSilent`: `bool`, default `false`. (Field exists but not visibly wired in this diff.)
- `LweVolume`: `int`, default `100`. (Field exists but not visibly wired in this diff.)
- `LweMonitors`: `List<LweMonitorSettings>`, default empty. Per-monitor LWE configuration.
- `SceneTransitionDelayMs`: `int`, default `1000`. Overlap duration for scene transitions.
- `AutoMuteOnlyIfMprisActive`: `bool`, default `false`. Conditional auto-mute gate.
- `ThumbnailAspect`: `string`, default `"Default"`. Card thumbnail aspect ratio.
- `CardSize`: `string`, default `"Medium"`. Card size multiplier.
- `LibrarySortIndex`: `int`, default `5`. Persisted library sort order.
- `GlobalWaitForVideoEnd`: `bool`, default `false`. Global "wait for video end" mode.
- `PlaylistWaitForVideoEnd`: `bool`, default `false`. Per-playlist "wait for video end" override.
- `Theme`: `string`, default `"Catppuccin Mocha"`. Persisted theme name.

#### Changed: `BuildMpvOptions()`

- Added `--speed=N` when `Speed != 1.0`.
- `--panscan=1.0` is now conditional: `if (VideoScale == "fill")`. Previously always added.

#### Changed: `BuildMpvPlaylistOptions()`

- Same changes as `BuildMpvOptions()` for speed and panscan.

---

## ### File: src/livepaper/Models/AppTheme.cs (new file)

- 10-line record:
  ```csharp
  public record AppTheme(
      string Name,
      string BgBase, string BgMantle, string BgCrust,
      string Surface0, string Surface1, string Surface2,
      string TextColor, string Subtext, string Muted,
      string Accent, string AccentFg, string AccentHover,
      string Danger, string DangerBg, string Success
  );
  ```
- Pure data holder, no behavior.

---

## ### File: src/livepaper/Models/LastSession.cs

#### New field

- `public bool WaitForVideoEnd { get; set; }` — persists the "wait for video end" mode into the session file.

---

## ### File: src/livepaper/Models/LibraryItem.cs

#### New fields (all `init`-only)

- `IsScene`: `bool` — true for `.scene` items.
- `WorkshopId`: `string?` — normalized numeric Steam workshop ID.
- `HasCrashed`: `bool` — true if a `.crashed` sidecar exists.
- `IsWhitelisted`: `bool` — true if a `.whitelist` sidecar exists.
- `VolumeOverride`: `int?` — per-video volume from `.volume` sidecar.
- `SpeedOverride`: `double?` — per-video speed from `.speed` sidecar.
- `AddedAt`: `System.DateTime` — file creation time.

---

## ### File: src/livepaper/Models/LweMonitorSettings.cs (new file)

- Simple DTO for per-monitor LWE configuration:
  ```csharp
  public class LweMonitorSettings
  {
      public string Name { get; set; } = "";
      public int Fps { get; set; } = 30;
      public bool IsPrimary { get; set; } = false;
  }
  ```
- Serialized as part of `AppSettings.LweMonitors`.

---

## ### File: src/livepaper/Models/WallpaperDetail.cs

#### New fields

- `IsScene`: `bool` — indicates the download target is a scene.
- `WorkshopId`: `string?` — workshop ID for scene items.

---

## ### File: src/livepaper/Models/WallpaperResult.cs

#### New using

- `using System;` — for `DateTime?`.

#### New fields

- `AnimatedThumbnailUrl`: `string?` — path/URL to a GIF thumbnail (WE animated previews).
- `IsScene`: `bool` — true for scene-type wallpapers.
- `WorkshopId`: `string?` — workshop ID.
- `AddedAt`: `DateTime?` — workshop item addition date (directory creation time).

---

## ### File: src/livepaper/Program.cs

#### Changed: `Main()` startup

- Added `PlayerHelper.LoadUserMuteState();` as first line — loads persisted user mute state before any command processing.

#### Changed: `toggle-mute` action

- Old: `PlayerHelper.SendCommand("cycle", "mute");` — sent an mpv cycle command.
- New: `PlayerHelper.SetUserMute(!PlayerHelper.IsUserMuted);` — uses the new user-mute API that persists state and correctly handles automute interaction.

---

## ### File: src/livepaper/Scrapers/WallpaperEngineScraper.cs

#### New usings

- `using System.Diagnostics;` — for `Process` (ffmpeg).
- `using System.Linq;` — for LINQ on file enumeration.

#### Changed: `GetAllAsync()` signature

- Old: `GetAllAsync(string workshopPath)`
- New: `GetAllAsync(string workshopPath, bool allowScenes = false, string query = "", int sortIndex = 0)`

#### Changed: `GetAllAsync()` — scene detection and inclusion

- For each workshop directory: reads `workshopId = Path.GetFileName(dir)`, `title` from `project.json` or directory name, calls `FindThumbnailAsync()` (now async), reads `addedAt` from directory creation time.
- Scene detection: `isScene = info?.Type == "scene" || (info == null && File.Exists("scene.pkg"))`.
- If scene and `!allowScenes`: skips. If scene and `allowScenes`: adds `WallpaperResult` with `IsScene = true`, `WorkshopId`, `AnimatedThumbnailUrl`, `AddedAt`.
- Video items also gain `WorkshopId` and `AddedAt`.

#### Changed: `GetAllAsync()` — filtering and sorting

- Client-side query filter: `results.FindAll(r => r.Title.Contains(query, OrdinalIgnoreCase))` if query non-empty.
- Sort: switch on `sortIndex`:
  - 0: unsorted (default)
  - 1: Name A→Z
  - 2: Name Z→A
  - 3: Videos first, then by name
  - 4: Scenes first, then by name
  - 5: Newest added (descending by `AddedAt`)
  - 6: Oldest added (ascending)

#### Changed: `FindThumbnail()` → `FindThumbnailAsync()` (private)

- Renamed from synchronous to `async Task<(string? Static, string? AnimatedGif)>`.
- Returns a tuple: `(staticPath, animatedGifPath)`.
- Preference: `preview.jpg` first (returns `(preview, null)`).
- Then: looks for any `*.gif` file. If found:
  - Defines `GifThumbCacheDir` = `~/.cache/livepaper/we_thumbs`.
  - Checks for cached static frame `<workshopId>.jpg`.
  - If not cached, calls `ExtractGifStaticFrameAsync(gifPath, staticCache)`.
  - Returns `(staticCache, gifPath)` if cache exists, else `(gifPath, null)`.
- Otherwise: returns first `*.png`, `*.jpg`, or `*.jpeg` as `(file, null)`.

#### New property: `GifThumbCacheDir` (private)

- `~/.cache/livepaper/we_thumbs` — cache directory for static frames extracted from GIF thumbnails.

#### New method: `ExtractGifStaticFrameAsync(string gifPath, string outputPath)` (internal)

- Three-stage ffmpeg extraction:
  1. First non-black/white frame using `signalstats,metadata` filter (YAVG between 30 and 225).
  2. Fallback: frame index 1 (`select=eq(n\\,1)`).
  3. Fallback: frame index 0 (no filter).
- Each stage checks output file existence and non-zero size before proceeding.
- Internal visibility allows `WallpaperCardViewModel.LoadStaticThumbnailAsync()` to call it.

#### New method: `RunFfmpeg(params string[] args)` (private)

- Generic async ffmpeg runner. Redirects stdout/stderr, awaits exit.

---

## ### File: src/livepaper/Services/DesktophutService.cs

#### New interface property implementation

- `public bool SupportsSorting => false;` — implements newly added `IBgsProvider.SupportsSorting`. Sort UI is hidden for this source.

---

## ### File: src/livepaper/Services/IBgsProvider.cs

#### New interface member

- `bool SupportsSorting { get; }` — all providers must now declare whether they support server-side or client-side sorting. Affects Browse tab sort button visibility.

---

## ### File: src/livepaper/Services/MoewallsService.cs

#### New interface property implementation

- `public bool SupportsSorting => false;`

---

## ### File: src/livepaper/Services/MotionBgsService.cs

#### New interface property implementation

- `public bool SupportsSorting => false;`

---

## ### File: src/livepaper/Services/WallpaperEngineService.cs

#### New fields

- `public bool AllowScenes { get; set; } = false;` — passed to scraper.
- `public int SortIndex { get; set; } = 0;` — current sort index, updated by UI before each load.

#### Changed: `SupportsSearch`

- Old: `false`. New: `true`. WE now supports client-side search (passed to `GetAllAsync(query)`).

#### New interface property implementation

- `public bool SupportsSorting => true;`

#### Changed: `GetLatestAsync()`

- Now passes `AllowScenes, sortIndex: SortIndex` to `GetAllAsync`.

#### Changed: `SearchAsync()`

- Old: returned empty list.
- New: calls `WallpaperEngineScraper.GetAllAsync(WorkshopPath, AllowScenes, query, SortIndex)`.

#### Changed: `GetDetailAsync()`

- Adds `IsScene = result.IsScene` and `WorkshopId = result.WorkshopId` to the returned `WallpaperDetail`.

---

## ### File: src/livepaper/ViewModels/LweMonitorViewModel.cs (new file)

**Purpose**: ViewModel for a single monitor entry in the LWE monitor list.

#### Fields/properties

- `[ObservableProperty] private int _index;` — 0-based index.
- `[ObservableProperty] private string _name;` — monitor name (e.g., "DP-1").
- `public int Fps { get; set; } = 30;` — plain property (not observable; binds via selection sync in VM).
- `public bool IsPrimary { get; set; } = false;` — only the primary monitor's LWE instance outputs audio.
- `public string DisplayName => $"Monitor {Index + 1}: {Name}";` — computed from `Index` and `Name`, both trigger `NotifyPropertyChangedFor`.
- Constructor: `LweMonitorViewModel(string name, int index = 0)`.

---

## ### File: src/livepaper/ViewModels/MainWindowViewModel.cs (major, ~859 line changes)

#### New public properties (static/options)

- `VideoScaleOptions`: `["fit", "fill"]`
- `ThumbnailAspectOptions`: `["Default", "16:9", "1:1"]`
- `CardSizeOptions`: `["Small", "Medium", "Large"]`
- `CardLayoutChanged`: `Action?` — invoked when card dimensions need recalculation; wired from code-behind.
- `Themes`: `IReadOnlyList<AppTheme> = ThemeService.All`
- `[ObservableProperty] private AppTheme _selectedTheme = ThemeService.Default;`

#### New observable properties

- `_allowScenes`: `bool`
- `_sceneTransitionDelayMs`: `decimal`
- `_lweMonitors`: `ObservableCollection<LweMonitorViewModel>`
- `_selectedLweMonitor`: `LweMonitorViewModel?`
- `_selectedMonitorFps`: `decimal` (default 30)
- `_selectedMonitorIsPrimary`: `bool`
- `_isAddingMonitor`: `bool`
- `_newMonitorName`: `string`
- `_videoScale`: `string` (default "fit")
- `_cardThumbnailHeight`: `double` (default 150)
- `_cardMinWidth`: `double` (default 210)
- `_thumbnailAspect`: `string` (default "Default")
- `_cardSize`: `string` (default "Medium")
- `_speed`: `double`
- `_autoMuteOnlyIfMprisActive`: `bool`
- `_playlistWaitForVideoEnd`: `bool`
- `_globalWaitForVideoEnd`: `bool`
- `_librarySearchQuery`: `string` (default "")
- `_librarySortIndex`: `int` (default 5)
- `_filteredLibraryWallpapers`: `List<WallpaperCardViewModel>`
- `_browseSortIndex`: `int` (default 0)
- `_canUndo`: `bool`

#### New computed properties (Display proxies)

- `DisplayIntervalHours`: reads from override vs global based on `OverrideGlobalSettings`.
- `DisplayIntervalMinutes`: same.
- `DisplayIntervalSeconds`: same.
- `DisplayAdvanceOnVideoEnd`: same.
- `DisplayWaitForVideoEnd`: same.
- These are exposed to the playlist settings UI; bound to `NumericUpDown` and `CheckBox` controls.

#### Changed: `ConfirmClearLibrary()`

- Before clearing library: purges all undo batches via `LibraryService.PurgeBatch()` and resets `CanUndo`.
- Calls `Stop()` before deleting.
- Resets `_currentlyPlayingCard = null`.

#### New partial property change handlers

- `OnAllowScenesChanged(bool)`: updates `_settings.AllowScenes`, updates `WallpaperEngineService.AllowScenes`, triggers `LoadWallpapersAsync()` if WE is selected, shows status if LWE not found.
- `OnSceneTransitionDelayMsChanged(decimal)`: saves to settings.
- `OnSelectedLweMonitorChanged(LweMonitorViewModel?)`: syncs `SelectedMonitorFps` and `SelectedMonitorIsPrimary` from the selected monitor.
- `OnSelectedMonitorFpsChanged(decimal)`: updates the selected monitor's `Fps`, calls `SaveLweMonitors()`.
- `OnSelectedMonitorIsPrimaryChanged(bool)`: enforces single-primary invariant. If deselecting the only monitor, defers a revert via `Dispatcher.UIThread.Post`. If deselecting with multiple monitors, auto-promotes the next one.
- `OnAutoMuteOnlyIfMprisActiveChanged(bool)`: saves and restarts `AudioMonitor.Start` with new flag.
- `OnVideoScaleChanged(string)`: calls `PlayerHelper.SetVideoScale(value)`, then `SaveAndRebuild()`.
- `OnThumbnailAspectChanged(string)`: fires `CardLayoutChanged?.Invoke()`, saves setting.
- `OnCardSizeChanged(string)`: fires `CardLayoutChanged?.Invoke()`, saves setting.
- `OnSelectedThemeChanged(AppTheme)`: calls `ThemeService.Apply(value)`, saves theme name.
- `OnLoopChanged(bool)`: added live `PlayerHelper.SetLoop(value)` call for single-video mode, and `RefreshPlayingStatus()`.
- `OnNoAudioChanged(bool)`: added `RefreshPlayingStatus()`.
- `OnSpeedChanged(double)`: if current card has no speed override, calls `PlayerHelper.SetSpeed(value)`. Updates all library cards via `c.UpdateGlobalSpeed(value)`. Saves and refreshes status.
- `OnVolumeChanged(int)`: if current card has no volume override, calls `PlayerHelper.SetVolume(value)`. Updates all library cards via `c.UpdateGlobalVolume(value)`.

#### Changed: All AutoMute change handlers

- Now pass `_settings.AutoMuteOnlyIfMprisActive` to `AudioMonitor.Start`.

#### Changed: `OnPlaylistShuffleChanged` and related handlers

- `OnPlaylistShuffleChanged`: adds `ApplyShuffleOrderIfRunning(value)` and `RefreshPlayingStatus()`.
- `OnPlaylistWaitForVideoEndChanged`: mutually exclusive with `AdvanceOnVideoEnd` (sets it false when WaitForVideoEnd is enabled); calls `ApplyEffectivePlaylistSettingsIfRunning()`.
- `OnAdvanceOnVideoEndChanged`: mutually exclusive with `PlaylistWaitForVideoEnd`.
- `OnGlobalAdvanceOnVideoEndChanged`: mutually exclusive with `GlobalWaitForVideoEnd`.
- `OnGlobalWaitForVideoEndChanged`: mutually exclusive with `GlobalAdvanceOnVideoEnd`.
- `OnOverrideGlobalSettingsChanged`: fires all `Display*` property notifications.

#### New method: `GetEffectiveWaitForVideoEnd()`

- Returns `OverrideGlobalSettings ? PlaylistWaitForVideoEnd : _settings.GlobalWaitForVideoEnd`.

#### Changed: `ApplyTimedSettingsIfRunning()` → `ApplyEffectivePlaylistSettingsIfRunning()`

- Major rewrite. Detects timed mode vs advance-on-end live.
- Checks `PlayerHelper.IsTimedModeActive` to detect mixed playlists upgraded to timed.
- For timed mode with playlists that contain scenes: passes `advanceOnVideoEnd` for scene-aware chain.
- Mode switching via IPC: calls `SwitchFromTimedToAdvanceOnEnd` or `SwitchFromAdvanceOnEndToTimed` as appropriate.
- For mixed playlists switching to advance-on-end: full restart via `ApplyPlaylist`.

#### New method: `ApplyShuffleOrderIfRunning(bool shuffle)`

- If a playlist is running, calls `PlayerHelper.ReorderPlaylist(paths, isTimedPlaylist, shuffle)` on a background thread.

#### New: Library filter/sort subsystem

- `UpdateFilteredLibrary()`: applies `ApplyLibraryFilter` and assigns to `FilteredLibraryWallpapers`.
- `OnLibrarySearchQueryChanged(string)`: debounced 200ms search via `CancellationTokenSource`, updates `_activeSearchQuery`, calls `UpdateFilteredLibrary()`.
- `OnLibrarySortIndexChanged(int)`: immediately calls `UpdateFilteredLibrary()`, saves `LibrarySortIndex`.
- `SetLibrarySort(string index)` (`[RelayCommand]`): parses and sets `LibrarySortIndex`.
- `ApplyLibraryFilter(source, query, sortIndex)` (private static): filters by title/WorkshopId, sorts by:
  - 0: name A→Z (default)
  - 1: name Z→A
  - 2: videos first
  - 3: scenes first
  - 4: newest added
  - 5: oldest added

#### New: Browse sort/auto-search subsystem

- `_browseSortIndex`: int observable.
- `OnBrowseSortIndexChanged(int)`: triggers `SearchAsync` or `LoadWallpapersAsync` if source supports sorting.
- `SetBrowseSort(string index)` (`[RelayCommand]`): parses and sets `BrowseSortIndex`.
- `OnSearchQueryChanged(string)`: debounced 200ms auto-search — fires `LoadWallpapersAsync` (empty) or `SearchAsync` (non-empty). This makes the Browse tab react to typing without needing a Search button.

#### Changed: `OnBrowseCardChanged` and `OnLibraryCardChanged`

- Old: used `Count(c => c.IsSelected)` — O(n) scan.
- New: incremental `Math.Max(0, LibrarySelectedCount + (card.IsSelected ? 1 : -1))`.

#### New private fields

- `_currentlyPlayingCard`: `WallpaperCardViewModel?` — tracks currently playing card for status display and overlay.
- `_suppressFilterUpdate`: `bool` — suppresses filter refresh during bulk `LoadLibrary()`.
- `_playlistSyncCts`: `CancellationTokenSource?` — debounces playlist sync to player.
- `_isSyncingVolume`, `_isSyncingSpeed`: `bool` — prevent re-entrant multi-selection sync.
- `UndoBatch` (nested sealed class): `{ string BatchDir; List<(WallpaperCardViewModel Card, bool WasInPlaylist)> Items; }`
- `_undoBatches`: `List<UndoBatch>` — stack of undoable deletes.

#### Constructor changes

- Loads all new settings fields into backing fields.
- Initializes `LweMonitors` from `_settings.LweMonitors`.
- Sets `weService.AllowScenes = _settings.AllowScenes`.
- Calls `LibraryService.CleanTrash()` at startup.
- AutoMute start now passes `AutoMuteOnlyIfMprisActive`.
- `LibraryWallpapers.CollectionChanged` now calls `UpdateFilteredLibrary()` unless `_suppressFilterUpdate`.
- `PlaylistItems.CollectionChanged` now calls `SyncPlaylistToPlayerIfRunning()`.
- Registers `PlayerHelper.OnWallpaperChanged`: clears old `_currentlyPlayingCard.IsCurrentlyPlaying`, finds new card by path, sets `IsCurrentlyPlaying = true`, calls `RefreshPlayingStatus()`.
- Registers `PlayerHelper.OnSceneCrashed`: calls `LibraryService.MarkCrashed(path)`, sets `card.HasCrashed = true`, removes from playlist if not whitelisted.
- After `LoadLibrary()`: calls `UpdateFilteredLibrary()`.
- Resume logic: calls `PlayerHelper.ResumeTimedTimer()` only (no early status set), then `RefreshPlayingStatus()`.

#### LWE monitor management (new methods)

- `AddMonitor(string name)`: creates `LweMonitorViewModel`, adds to list, saves.
- `UpdateMonitorIndices()`: re-indexes all monitors by position.
- `SaveLweMonitors()`: serializes to `_settings.LweMonitors`, saves.
- `StartAddMonitor()` (`[RelayCommand]`): sets `NewMonitorName = ""`, `IsAddingMonitor = true`.
- `ConfirmAddMonitor()` (`[RelayCommand]`): validates name, calls `AddMonitor`, clears state.
- `CancelAddMonitor()` (`[RelayCommand]`): clears state.
- `RemoveSelectedMonitor()` (`[RelayCommand]`): removes from list, promotes next as primary if needed.

#### Changed: `SelectAll()`

- Now operates on `FilteredLibraryWallpapers` instead of `LibraryWallpapers`.

#### New: `DeselectAllLibrary()` and `DeselectAllBrowse()` (public)

- Clear selection on the appropriate collection, reset `_lastSelectedIndex`.
- Called from code-behind when clicking empty space.

#### Changed: `SelectCard()` and `SelectBrowseCard()`

- `SelectCard` now operates on `FilteredLibraryWallpapers` list for index calculation and range selection.
- Uses `LibrarySelectedCount` instead of `Count(c => c.IsSelected)` for O(1) "wasOnlySelected" check.

#### Changed: `OnSourceSelected()`

- Resets `BrowseSortIndex = 0` when source changes.

#### Changed: `LoadWallpapersAsync()`

- Before fetching: if source is `WallpaperEngineService`, sets `weService.SortIndex = BrowseSortIndex`.

#### Changed: `SearchAsync()`

- Before fetching: if source is `WallpaperEngineService`, sets `weServiceSearch.SortIndex = BrowseSortIndex`.

#### Changed: Download flow in `DownloadSelectedAsync()`

- Passes `IsScene = target.IsScene` and `WorkshopId = target.WorkshopId` when constructing the `WallpaperResult` for `GetDetailAsync`.

#### Changed: `DeleteCards()` → soft delete with undo

- Now calls `LibraryService.Trash(target.LibraryItem, batchDir)` instead of `Delete`.
- Builds `UndoBatch`, adds to `_undoBatches`, sets `CanUndo = true`.
- Status message includes "(Ctrl+Z to undo)".

#### New method: `UndoDelete()` (`[RelayCommand]`)

- Pops last `UndoBatch`, calls `LibraryService.RestoreBatch(batch.BatchDir)`.
- Re-adds cards to `LibraryWallpapers` and `PlaylistItems` as appropriate.
- Status message: "Restored N wallpapers" or "Restored: <title>".

#### New method: `PurgeTrash()`

- Permanently deletes all undo batches. Called from code-behind `OnClosed`.

#### New method: `Stop()` (`[RelayCommand]`)

- Calls `PlayerHelper.Stop()`, `AudioMonitor.KillDetachedMonitor()`, clears status, clears `_currentlyPlayingCard.IsCurrentlyPlaying`.

#### Changed: Playlist play methods (`PlayCustomPlaylistCommand`, `PlayFromCard`)

- Pass `WaitForVideoEnd` to `ApplyTimedPlaylist` and `LastSession`.
- When `GetEffectiveAdvanceOnVideoEnd()` is true: checks `PlayerHelper.IsTimedPlaylistActive()` to detect mixed-playlist upgrade; saves as `IsTimedPlaylist` if upgraded.
- Status messages replaced by `RefreshPlayingStatusSoon()`.
- Pass `GetEffectiveIntervalSeconds()` to `ApplyPlaylist`.

#### Changed: `PlayLibrary()`

- Passes `_settings.GlobalIntervalSeconds` to `ApplyPlaylist`.
- Passes `_settings.GlobalWaitForVideoEnd` to `ApplyTimedPlaylist`.

#### Changed: `LoadLibrary()`

- Wraps iteration in `_suppressFilterUpdate = true/false` block to prevent per-item filter recalculation during bulk load.

#### New: `SyncSelectedVolume(WallpaperCardViewModel source, int? volume)`

- When a selected card's volume slider changes, propagates to all other selected cards (either sets same override or resets to global).
- Guards re-entrancy via `_isSyncingVolume`.

#### New: `SyncSelectedSpeed(WallpaperCardViewModel source, double? speed)`

- Same pattern for speed.

#### Changed: `MakeLibraryCard()`

- Wires `card.OnVolumeChanged = SyncSelectedVolume`.
- Wires `card.OnSpeedChanged = SyncSelectedSpeed`.
- Calls `card.UpdateGlobalVolume(Volume)` and `card.UpdateGlobalSpeed(Speed)`.
- Calls `card.LoadDurationAsync()` — triggers async ffprobe.
- Calls `card.LoadStaticThumbnailAsync()` — triggers async GIF frame extraction.

#### New: `SyncPlaylistToPlayerIfRunning()`

- 100ms debounced sync: when playlist items change, updates `s.Paths`, saves settings, calls `PlayerHelper.ReorderPlaylist` (timed) or `PlayerHelper.SyncAdvanceOnEndPlaylist` (advance-on-end), refreshes status.

#### Changed: `RestorePlaylistState()` and `LoadPlaylist()`

- Replaced `FirstOrDefault` O(n) lookup with dictionary lookup (`ToDictionary` by `VideoPath`).

#### New: `RefreshPlayingStatus()` and `RefreshPlayingStatusSoon()`

- `RefreshPlayingStatus()`: rebuilds `StatusMessage` from current state:
  - Timed playlist: `{count} wallpapers, every {interval}` + shuffle flag + current title.
  - Advance-on-end: `{count} wallpapers, on video end` + shuffle + current title.
  - Single: current card title.
  - Appends `Vol {N}%`, `Loop`, speed if not 1×.
- `RefreshPlayingStatusSoon()`: polls for 5s if not yet playing, then calls `RefreshPlayingStatus`.
- All previous hardcoded `StatusMessage = "..."` assignments replaced by these calls.

---

## ### File: src/livepaper/ViewModels/WallpaperCardViewModel.cs

#### New usings

- `System.Diagnostics`, `System.Globalization`, `System.IO`, `System.Threading.Tasks`, `Avalonia.Threading`, `livepaper.Helpers`, `livepaper.Scrapers`.

#### New properties (browse-card)

- `IsScene`: `bool` — identifies scene wallpapers.
- `WorkshopId`: `string?` — workshop ID for WE items.
- `StaticThumbnailSource`: `[ObservableProperty] string?` — path to static JPG extracted from GIF.
- `IsGifThumbnail`: `bool` computed — `ThumbnailSource.EndsWith(".gif")`.
- `GifSource`: lazy `AnimatedImage.Avalonia.AnimatedImageSource?` — loaded on first access via `LoadGifSource()`.
- `IsGifActive`: `[ObservableProperty] bool` — set to true on pointer enter, false on exit; drives `ActiveGifSource`.
- `ActiveGifSource`: computed — `IsGifActive ? GifSource : null`. Triggers `OnPropertyChanged` via `OnIsGifActiveChanged`.

#### New method: `LoadGifSource()`

- Returns `AnimatedImageSourceUri` for http URLs, `AnimatedImageSourceStream` for local paths.

#### New observable properties (library-card)

- `VideoDuration`: `string` — formatted duration from ffprobe (lazy loaded).
- `HasCrashed`: `bool` — from `LibraryItem.HasCrashed`.
- `IsWhitelisted`: `bool` — from `LibraryItem.IsWhitelisted`.
- `SliderVolume`: `int` — current slider value (override or global).
- `SliderSpeed`: `double` — current slider value (override or global).
- `IsCurrentlyPlaying`: `bool` — set by `MainWindowViewModel` via `OnWallpaperChanged`.

#### Private state fields

- `_volumeOverride`: `int?` — null when synced to global.
- `_globalVolume`: `int` — last known global volume.
- `_suppressSliderChange`: `bool` — prevents `OnSliderVolumeChanged` feedback loop.
- `_speedOverride`: `double?`
- `_globalSpeed`: `double`
- `_suppressSpeedChange`: `bool`

#### Computed properties (library-card)

- `IsSpeedSliderVisible`: `LibraryItem != null && !IsScene` — scenes don't support speed.
- `IsVolumeSynced`: `_volumeOverride == null`.
- `VolumeOverride`: `_volumeOverride` (exposed for VM to check before applying global volume).
- `IsSpeedSynced`: `_speedOverride == null`.
- `SpeedOverride`: `_speedOverride`.

#### New change handlers

- `OnIsWhitelistedChanged(bool)`: calls `LibraryService.SetWhitelisted(LibraryItem.VideoPath, value)`.
- `OnSliderVolumeChanged(int)`: if not suppressed and LibraryItem present, sets `_volumeOverride`, notifies properties, saves sidecar, applies live if currently playing, fires `OnVolumeChanged`.
- `OnSliderSpeedChanged(double)`: same pattern for speed.

#### New commands

- `SyncToGlobal()` (`[RelayCommand]`): clears `_volumeOverride`, resets slider to global (suppressed), saves null sidecar, applies live, fires `OnVolumeChanged?.Invoke(this, null)`.
- `SyncSpeedToGlobal()` (`[RelayCommand]`): same for speed.

#### New methods

- `UpdateGlobalVolume(int volume)`: updates `_globalVolume`, updates slider if not overridden (suppressed).
- `UpdateGlobalSpeed(double speed)`: same pattern.
- `LoadDurationAsync()`: background ffprobe call, posts result to UI thread.
- `ReadDuration(string path)` (private static): runs `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 <path>`, formats as "N hours, N minutes, N seconds".
- `LoadStaticThumbnailAsync()`: if GIF thumbnail and no static yet, calls `WallpaperEngineScraper.ExtractGifStaticFrameAsync`, posts path to UI thread.

#### Callbacks

- `OnVolumeChanged`: `Action<WallpaperCardViewModel, int?>?` — wired by `MainWindowViewModel.MakeLibraryCard`.
- `OnSpeedChanged`: `Action<WallpaperCardViewModel, double?>?`

#### Changed: Constructor `WallpaperCardViewModel(WallpaperResult result)`

- When `result.AnimatedThumbnailUrl != null`: sets `ThumbnailSource = animatedUrl` (GIF), `_staticThumbnailSource = result.ThumbnailUrl` (JPG).
- Otherwise: `ThumbnailSource = result.ThumbnailUrl`.
- Sets `IsScene`, `WorkshopId`.

#### Changed: Constructor `WallpaperCardViewModel(LibraryItem item)`

- Sets `IsScene`, `WorkshopId`.
- Sets `_hasCrashed`, `_isWhitelisted` from item.
- Sets `_volumeOverride`, `_sliderVolume`, `_speedOverride`, `_sliderSpeed` from item overrides.
- Pre-populates `_staticThumbnailSource` from WE GIF cache if applicable.

---

## ### File: src/livepaper/Views/MainWindow.axaml (major, ~1256 line changes)

#### New XML namespaces

- `xmlns:mi="clr-namespace:Material.Icons.Avalonia;assembly=Material.Icons.Avalonia"`
- `xmlns:aimg="clr-namespace:AnimatedImage.Avalonia;assembly=AnimatedImage.Avalonia"`

#### New Window resource: `ThumbnailDisplay` ControlTemplate

- Key: `ThumbnailDisplay`, `TargetType="TemplatedControl"`.
- A `Panel` with three layers:
  1. `AdvancedImage` bound to `StaticThumbnailSource` (visible when non-null) — shows static JPG.
  2. `AdvancedImage` bound to `ThumbnailSource` (visible when `StaticThumbnailSource` null) — shows regular image.
  3. `Image` with `aimg:ImageBehavior.AnimatedSource="{Binding ActiveGifSource}"` — shows animated GIF when `IsGifActive` is true.
- Used in both Browse and Library card thumbnails.

#### Changed: Root Grid layout

- Old: `RowDefinitions="*,Auto"` (2 rows: content + status bar).
- New: `RowDefinitions="*,Auto,Auto"` (3 rows: content + playlist panel + status bar).

#### Browse tab — Top bar changes

- Removed explicit "Search" button and `TextBox.KeyBindings` Enter handler. Search is now auto-triggered by debounced `OnSearchQueryChanged`.
- Added sort button: `Button Classes="ghost"` with `IsVisible="{Binding SelectedSource.SupportsSorting}"` and a `MenuFlyout` containing 7 sort options (Default, Name A–Z, Name Z–A, Videos first, Scenes first, Newest added, Oldest added). Uses `Material.Icons Kind="SortVariant"`.
- Refresh button: replaced text `"↺"` with `<mi:MaterialIcon Kind="Refresh"/>`.

#### Browse grid — ItemsControl → ItemsRepeater

- Old: `ItemsControl` with `WrapPanel`.
- New: `ItemsRepeater` with `UniformGridLayout MinItemWidth="{Binding CardMinWidth}"` and `ItemsStretch="Fill"`. Enables responsive column count.
- `ScrollViewer`: added `HorizontalScrollBarVisibility="Disabled"` and `AllowAutoHide="False"`.
- Card `Border`: removed fixed `Width="210"`, added `PointerEntered/PointerExited` handlers for GIF activation.
- Thumbnail `Button`: replaced `AdvancedImage` with `<TemplatedControl Template="{StaticResource ThumbnailDisplay}"/>`. Added `HorizontalAlignment="Stretch"`, `CornerRadius="10,10,0,0"`, `ClipToBounds="True"`.
- Added **SCENE badge**: `Border` visible when `IsScene`, `Background=Accent`, `CornerRadius=4`, `TextBlock Text="SCENE"` 9px bold.
- Height row changed from fixed `150` to `Auto` with `Height="{Binding CardThumbnailHeight}"`.
- State overlays: Old single `IsSelected` border replaced with `Panel` containing: hover outline (`.library-hover-outline`), selected border.

#### Library tab — Header changes

- Added "Stop" button (`Classes="danger"`), Command=`StopCommand`.
- Added `TextBox Text="{Binding LibrarySearchQuery}"` for library search.
- Added sort button with 6 sort options (no "Default" here — Name A–Z is 0): MenuFlyout commands `SetLibrarySort` with parameters 0–5.
- Buttons use `mi:MaterialIcon` for sort icon.

#### Library tab — Playlist panel REMOVED from `DockPanel.Dock="Bottom"`

- The entire embedded playlist panel (with horizontal thumbnail strip, settings gear, load/save buttons) is removed from its old position inside the Library tab's DockPanel.
- It is replaced by the new standalone `PlaylistPanel` (Grid.Row="1").

#### Library grid — ItemsControl → ItemsRepeater

- Same changes as Browse: `ItemsRepeater` with `UniformGridLayout`, `FilteredLibraryWallpapers` as source.
- Card `Border`: added `PointerEntered/PointerExited`.
- Thumbnail area: uses `ThumbnailDisplay` template. SCENE badge added.
- Title row: wrapped in `Grid ColumnDefinitions="Auto,*"`: warning icon `"⚠ "` visible when `HasCrashed` with tooltip "This scene crashed during playback", then title `TextBlock`.
- State overlays: now a `Panel` with 4 borders: hover outline, `IsCurrentlyPlaying` (green `Success` brush), `IsSelected` (accent), `HasCrashed` (danger red).

#### Playlist settings overlay — Updated

- Interval fields now bind to `Display*` proxies (`DisplayIntervalHours`, etc.) instead of raw `IntervalHours`.
- Added `CheckBox Content="Switch when video ends"` and `CheckBox Content="Wait for video to end after interval fires before switching"` before the interval spinners (in the `IsEnabled="{Binding OverrideGlobalSettings}"` block).
- The interval spinner group is no longer gated by `!AdvanceOnVideoEnd`.

#### Settings tab — New sections

**Speed slider** (Playback section):
- `Grid ColumnDefinitions="Auto,*,Auto"` with `Slider Minimum=0.1 Maximum=4 TickFrequency=0.1` bound to `Speed`.
- Value display: `{Binding Speed, StringFormat='{}{0:F1}x'}`.

**GlobalWaitForVideoEnd** (Playlist section):
- New `CheckBox Content="Wait for video to end after interval fires before switching"` bound to `GlobalWaitForVideoEnd`.
- Interval spinners no longer gated by `!GlobalAdvanceOnVideoEnd`.

**AutoMuteOnlyIfMprisActive** (Auto-mute section):
- New `CheckBox Content="Only mute if MPRIS media player is active"` bound to `AutoMuteOnlyIfMprisActive`, `IsEnabled="{Binding AutoMute}"`.

**VideoScale** (Rendering section):
- Rendering section extended to 2 rows.
- Row 2: "Video scale" label + `ComboBox ItemsSource="{Binding VideoScaleOptions}"`.

**Scenes / LWE settings** (Sources section):
- New `CheckBox Content="Allow scene support (experimental)"` bound to `AllowScenes`.
- Below: `StackPanel IsVisible="{Binding AllowScenes}"` containing:
  - "Monitors" label.
  - Help text explaining monitor names and how to find them.
  - Monitor selector row: `ComboBox` for `LweMonitors`, `+` button (`StartAddMonitorCommand`), `✕` button (`RemoveSelectedMonitorCommand`).
  - Add monitor input row (visible when `IsAddingMonitor`): `TextBox PlaceholderText="e.g. DP-1"`, Add and Cancel buttons.
  - Per-monitor settings (visible when `SelectedLweMonitor != null`): FPS `NumericUpDown`, "Primary" checkbox.
  - Transition delay: `NumericUpDown Value="{Binding SceneTransitionDelayMs}"` 0–5000ms, step 50.

**Appearance section** (new):
- Three-row `Grid`: Theme `ComboBox`, Thumbnail aspect `ComboBox`, Card size `ComboBox`.
- Theme `ComboBox ItemsSource="{Binding Themes}"` with `DataTemplate Text="{Binding Name}"`.

#### New standalone PlaylistPanel (Grid.Row="1")

- `Border x:Name="PlaylistPanel"` initially `IsVisible="False"`.
- Becomes visible when Library tab (index 1) is selected — wired in code-behind via `MainTabControl.SelectionChanged`.
- Contains:
  - Header: `PLAYLIST` label + settings/load/save/play buttons using `mi:MaterialIcon Kind="Tune"/"FolderOpen"/"ContentSave"/"Play"`.
  - Empty state text.
  - Playlist scroll area: `ItemsControl x:Name="PlaylistItemsControl"` with `StackPanel Orientation=Horizontal`.
  - Item template: `Border Width=100 CornerRadius=6`. Uses `StaticThumbnailSource` / `ThumbnailSource` / animated GIF triple-layer panel. Shows `IsGifActive` accent border overlay, `IsCurrentlyPlaying` success border. Has PointerEntered/Exited handlers.
  - Drop indicator: `Border x:Name="PlaylistDropIndicator"`.

#### Status bar (Grid.Row="2")

- Moved from Grid.Row="1" to Grid.Row="2".
- Changed from simple `TextBlock` to `DockPanel`:
  - Right-docked: undo button (`IsVisible="{Binding CanUndo}"`, `Command=UndoDeleteCommand`). Has a 1.8s border blink animation (two white pulses) triggered on visibility. Contains `mi:MaterialIcon Kind="Undo"` + "Undo" text.
  - Left: status `TextBlock` `VerticalAlignment="Center"`.

#### Modal updates

- All modals updated from `Grid.RowSpan="2"` to `Grid.RowSpan="3"`.
- Preview modal expanded from `Grid RowDefinitions="*,Auto"` to `Grid RowDefinitions="*,Auto,Auto,Auto,Auto"`:
  - Row 0: image (now with animated GIF support via `aimg:ImageBehavior.AnimatedSource`).
  - Row 1: Crash warning panel (visible when `PreviewCard.HasCrashed`): amber border, description text, whitelist checkbox.
  - Row 2: Per-wallpaper volume slider (visible for library items): `Slider 0–100`, value display, "↺ Global" button (visible when `!IsVolumeSynced`).
  - Row 3: Per-wallpaper speed slider (visible when `IsSpeedSliderVisible`): `Slider 0.1–4`, value display, "↺ Global" button.
  - Row 4: title (now `TextBox IsReadOnly=True`), `VideoDuration` subtitle, workshop ID row with copy button, download buttons.

#### Drag preview changes

- `DragPreviewBorder`: size changed from `50×45` to `67×60`.
- Removed `asyncImageLoader:AdvancedImage` child — image is now set via `VisualBrush { Visual = _dragSourceVisual }` in code-behind.
- `DragPreviewCanvas.Grid.RowSpan` updated to 3.

---

## ### File: src/livepaper/Views/MainWindow.axaml.cs

#### New using

- `using Avalonia.Controls.Primitives;` — for `ScrollBarVisibility` enum used in `SmoothScroller`.

#### New layout constants

- `MinCardWidthLandscape = 250`
- `MinCardWidthPortrait = 160`
- `CardHorizontalMargin = 8`
- (`PlaylistItemWidth`, `PlaylistItemSpacing`, `PlaylistItemStride` were already present, reorganized.)

#### New field

- `_lastRepeaterWidth`: `double` — caches last known repeater width for `UpdateCardThumbnailHeight`.
- `_dragSourceVisual`: `Visual?` — captures the `Border` visual of the dragged playlist item for `VisualBrush`.

#### Constructor changes

- Adds `SmoothScroller` for `BrowseScrollViewer`, `LibraryScrollViewer`, `SettingsScrollViewer`, `PlaylistScrollViewer`.
- `Loaded` handler: hooks `SizeChanged` on both `ItemsRepeater` controls, wires `Vm.CardLayoutChanged = UpdateCardThumbnailHeight`, calls `UpdateCardThumbnailHeight()`.
- `MainTabControl.SelectionChanged`: sets `PlaylistPanel.IsVisible = (SelectedIndex == 1)`.

#### New override: `OnClosed(EventArgs e)`

- Calls `Vm?.PurgeTrash()` — permanently deletes all trash batches on window close.

#### Changed: `OnKeyDown()`

- Escape now also clears Browse selection (Tab 0) or Library selection (Tab 1).
- Added Delete key handler: triggers `DeleteSelectedCommand` when Library tab active and items selected.
- Added Ctrl+Z handler: triggers `UndoDeleteCommand` when `CanUndo` is true.

#### Changed: `OnPointerPressed()`

- Library/Browse empty-space click: `if (card == null) { Vm?.DeselectAllLibrary(); return; }` and `{ Vm?.DeselectAllBrowse(); return; }`.
- Playlist drag: captures `_dragSourceVisual = FindAncestor<Border>(source, PlaylistScrollViewer)`.

#### Changed: `OnPointerMoved()`

- Drag start: instead of `DragPreviewImage.Source = ...`, sets `_dragCard.IsGifActive = true` (if GIF) and assigns a `VisualBrush { Visual = _dragSourceVisual }` to `DragPreviewBorder.Background`.
- Drag offset changed from `(-25, -22)` to `(-17, -15)` to center the larger preview.

#### Changed: `OnPointerCaptureLost()` and `OnPointerReleased()`

- Both now call `_dragCard.IsGifActive = false` and reset `_dragSourceVisual = null`.

#### New static method: `FindAncestor<T>(Visual? v, Visual? stopAt = null)`

- Walks visual tree upward looking for `T`. Used to find the `Border` container of a playlist item for `VisualBrush`.

#### New event handlers: `OnCardPointerEntered` and `OnCardPointerExited`

- `OnCardPointerEntered`: sets `card.IsGifActive = true`.
- `OnCardPointerExited`: sets `card.IsGifActive = false` if card is not the active drag card.

#### New method: `UpdateCardThumbnailHeight()`

- Computes `CardThumbnailHeight` and `CardMinWidth` from repeater width, `ThumbnailAspect`, and `CardSize`.
- Aspect ratios: `1:1` → `(160, 1.0)`, `16:9` → `(250, 9/16)`, Default → `(210, 150/210)`.
- Size multipliers: Small=0.65, Large=1.5, Medium=1.0.
- Column count: `Math.Floor(width / minCardWidth)`.
- `CardThumbnailHeight = Math.Round(cardWidth * ratio)`.

#### New nested class: `SmoothScroller`

- Implements momentum-based scroll on `ScrollViewer` via Avalonia's `RequestAnimationFrame`.
- Constants: `Impulse = 80.0`, `Friction = 0.85`, `StopThreshold = 0.1`, `MaxVelocity = 2500.0`.
- `OnWheel`: accumulates `_velocity -= delta * Impulse`, clamps to `±MaxVelocity`, marks handled, starts animation loop if not already animating.
- `OnFrame`: applies friction each frame: `_velocity *= Friction^(dt/16)`. Stops when `|velocity| < 0.1`. Determines scroll direction (horizontal vs vertical) by checking `ScrollBarVisibility`. Advances `_sv.Offset` by `velocity * (dt/16)`. Clamps and zeroes velocity at boundaries.
- Handles both vertical and horizontal scroll viewers.

---

## ### File: src/livepaper/livepaper.csproj

#### New NuGet packages

- `Avalonia.Controls.ItemsRepeater` `Version="12.0.0"` — provides the `ItemsRepeater` control used in Browse and Library grids.
- `AnimatedImage.Avalonia` `Version="2.1.4"` — provides animated GIF rendering for WE scene thumbnails.
- `Material.Icons.Avalonia` `Version="3.0.2"` — provides `mi:MaterialIcon` throughout the UI.

---

## Cross-Cutting Summary of Major Feature Additions

### 1. linux-wallpaperengine (LWE) Scene Support

`AppSettings.AllowScenes`, `LweMonitors`, `SceneTransitionDelayMs` gate the feature. `WallpaperEngineScraper` detects and includes scene items. `.scene` files store workshop IDs. `PlayerHelper` spawns per-monitor LWE processes, implements video↔scene pre-launch transitions with overlap timing, detects scene crashes and fires `OnSceneCrashed`. Volume/mute for LWE go through PulseAudio `pactl` since LWE has no IPC socket.

### 2. Per-video Volume and Speed Overrides

`.volume` and `.speed` sidecar files per library item. `LibraryService` reads/writes them. `WallpaperCardViewModel` exposes sliders with global-sync toggle. `PlayerHelper.ObservePathAsync` applies overrides via `playlist-pos` IPC events. `BakeVolumeOverride`/`BakeSpeedOverride` inject overrides into cold-start mpv arguments. `DoVideoEndWait` applies B's overrides after A ends but before B's first frame.

### 3. Soft Delete with Undo

`LibraryService.Trash()` moves files to `.trash/<batchId>/`. `MainWindowViewModel` maintains `_undoBatches` stack. `UndoDeleteCommand` restores last batch. `PurgeTrash()` permanently deletes on window close. Ctrl+Z keyboard shortcut. Animated undo button in status bar.

### 4. Runtime Theme Switching

`AppTheme` record, `ThemeService` with 31 named themes. Applied by writing `SolidColorBrush` directly into `Application.Current.Resources`. All XAML bindings converted from `StaticResource` to `DynamicResource`. Theme persisted in `AppSettings.Theme`. Applied at app init before window show.

### 5. Library Filter, Sort, and Search

`FilteredLibraryWallpapers` replaces direct `LibraryWallpapers` binding in the library grid. Debounced search on title and WorkshopId. Six sort options. `LibrarySortIndex` persisted. Browse tab gains equivalent sort for WE source.

### 6. Responsive Card Layout

`ItemsRepeater + UniformGridLayout` replaces `WrapPanel + ItemsControl`. `CardMinWidth` and `CardThumbnailHeight` computed from window width, `ThumbnailAspect`, and `CardSize`. Three size modes. Three aspect ratio modes. Layout recalculated on repeater `SizeChanged`.

### 7. Animated GIF Thumbnails

WE items with GIF previews: static frame extracted via ffmpeg `signalstats` filter, cached in `~/.cache/livepaper/we_thumbs/`. Card uses static frame at rest, animates on hover via `AnimatedImage.Avalonia`. Drag preview uses `VisualBrush` on the source border.

### 8. Wait-for-Video-End Mode

New `_waitForVideoEnd` flag in timed playlists: when interval fires, waits for current video to finish naturally before switching. Implemented via `DoVideoEndWait` task monitoring `playtime-remaining` via IPC. Sleep loop wakes on speed changes via `_speedChangeTcs`. Timer scales by `_currentSpeed` so interval counts video-time, not wall-clock.

### 9. Scene Crash Handling

`TimerTick` detects when current item is a scene path with no running LWE. Fires `OnSceneCrashed` event. VM marks `.crashed` sidecar, sets `HasCrashed = true` on card, removes from playlist unless whitelisted. Preview modal shows crash warning with whitelist toggle.

### 10. Smooth Scrolling

`SmoothScroller` class wraps any `ScrollViewer` with momentum-based physics (friction=0.85, impulse=80px per scroll tick, max 2500px/s). Applied to Browse, Library, Settings, and Playlist scroll viewers.
