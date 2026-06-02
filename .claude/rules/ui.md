---
paths:
  - "src/livepaper/Views/**"
  - "src/livepaper/ViewModels/**"
---

## UI Structure

The app has three tabs:

### Browse Tab
- Source selector (pill-style): motionbgs.com, moewalls.com, Desktophut, Wallpaper Engine local
- Grid of wallpaper cards (`ItemsRepeater + UniformGridLayout`, responsive columns); thumbnail + title + SCENE badge; clicking thumbnail opens fullscreen preview modal; GIF thumbnails animate on hover
- **Auto-search**: search box triggers debounced (200ms) load — no Search button
- **Sort button** (WE local only, `SupportsSorting`): Name A–Z/Z–A, Newest/Oldest added
- Refresh button and loading bar (thin strip below top bar, no layout shift)
- Per-card "Download & Apply" downloads + applies that card only
- **Selection toolbar** docks at bottom when ≥1 selected (Shift/Ctrl-click, Ctrl+A): "N selected", `Download` (no apply), `Cancel`
- **Right-click card**: web sources → "Open Page" (`xdg-open PageUrl`); WE local → "Open in File Manager" (D-Bus `ShowItems`, fallback `xdg-open dir`). Driven by `IsLocalSource` (`PageUrl` not http).

### Library Tab
- Grid of downloaded wallpapers (`ItemsRepeater + UniformGridLayout`, responsive columns); **compact card design**: thumbnail with overlay elements, zooms slightly on hover
- Card overlays (stacked `Panel`): SCENE badge, ⚠ if `HasCrashed`, checkmark corner when `IsSelected`, green outline when `IsCurrentlyPlaying`
- `IsAnyStateOverlay` property on `WallpaperCardViewModel` — true when `HasCrashed || IsSelected || IsCurrentlyPlaying`; drives overlay visibility
- **Multiselect**: Ctrl-click (toggle) / Shift-click (range); actions (Apply, Delete, Add/Remove Playlist) propagate to all selected cards. No separate selection toolbar — actions apply to selection automatically.
- Library search (debounced 200ms) + sort (Name A–Z/Z–A, Newest/Oldest)
- "Import": file picker (`.mp4`/`.webm`/`.mov`/`.mkv`/`.avi`/`.gif`); title modal copies to library, ffmpeg 320px thumbnail at 1s. `.id` holds `import:<source-path>`.
- "Play All" + "Shuffle" toggle — follows global Settings → PLAYLIST
- Per-card: Apply, Delete (soft-delete → `.trash/`; **Delete** key also triggers; **Ctrl+Z** undo)
- **Right-click card**: "Add to Playlist", "Open in File Manager" (D-Bus `ShowItems`; scenes use `CopiedSceneDir` or WE workshop dir; symlinks resolved), "Settings" (opens preview modal)
- **Preview modal** (click thumbnail): crash warning + whitelist toggle; title, workshop ID (copy button); **video duration**; per-wallpaper volume slider (0–100, "↺ Global"); per-wallpaper speed slider (0.1–4×)
- **Playlist strip** (always visible at bottom): horizontal small thumbnails; `−` badge; hover → dim + ▶ overlay + hover outline; drag to reorder; click plays; playing item has green outline (`Classes.playing`)
  - ⚙ settings popup (Sequential/Shuffle; `Override global rotation settings` unlocks Interval, AdvanceOnVideoEnd, WaitForVideoEnd)
  - 📂/💾 load/save named playlists → `~/.local/share/livepaper/playlists/<name>.json`
  - ▶ Play; auto-state saved to `~/.config/livepaper/playlist_state.json`
  - GIF hover in playlist strip
  - **Right-click item**: "Remove from Playlist", "Open in File Manager", "Settings"
- **Status bar**: playback info; animated undo button when `CanUndo`

### Settings Tab
- **Playback**: Loop, Mute audio, Disable cache, Volume (0–100, live IPC), Speed (0.1–4.0×, live IPC)
- **Playlist (global rotation)**: Switch when video ends, Wait for video to end, Hours/Minutes/Seconds interval
- **Auto-Mute**: threshold/delay knobs + "Only mute if MPRIS active" checkbox
- **Memory**: Demuxer max bytes / back bytes (NumericUpDown, integer MiB)
- **Rendering**: Hardware decoding (auto/nvdec/vaapi/no), Video scale (fill/fit)
- **Sources / Wallpaper Engine**: workshop folder picker, Copy files toggle (`WeCopyFiles`), "Allow scene support" checkbox, "Automatically add new WE wallpapers to library" (`AutoImportWallpaperEngine`); monitor list editor (name, FPS, primary toggle), scene transition delay slider
- **Library automation** (Playlist section): "Automatically add newly added library items to playlist" (`AutoAddLibraryToPlaylist`)
- **Appearance**: Theme selector (31 built-in), Thumbnail aspect (Default/16:9/1:1), Card size (Small/Medium/Large)
- Live mpv options preview; Reset to Defaults; keybind snippets for `--action=…`

### Context Menu Callback Pattern
Context menus are outside the visual tree — `$parent[Window]` doesn't work inside `<ContextMenu>`. Use action callbacks on `WallpaperCardViewModel` instead (e.g. `OnTogglePlaylist`, `OnOpenSettings`), wired in `MainWindowViewModel.CreateLibraryCard`. Commands on the VM itself work fine.

## Key NuGet Packages

- `Avalonia`, `Avalonia.Desktop`, `Avalonia.Themes.Fluent` — UI framework
- `Avalonia.Controls.ItemsRepeater` — `ItemsRepeater` for Browse and Library grids
- `AsyncImageLoader.Avalonia` — `AdvancedImage` for HTTP image loading (bind `Source` to string URL)
- `Material.Icons.Avalonia` — `<mi:MaterialIcon Kind="..."/>`
- `AnimatedImage.Avalonia` — animated GIF; use `aimg:ImageBehavior.AnimatedSource` (not `Source`)
- `CommunityToolkit.Mvvm` — `[ObservableProperty]`, `[RelayCommand]`, source generators
- `HtmlAgilityPack` — HTML parsing for scrapers
- `System.Text.Json` — JSON for `project.json` and settings

## Avalonia Gotchas

- **`NumericUpDown.Value` is `decimal?`** — binding to `int` fails silently. Always use `decimal` for `NumericUpDown`-bound properties.
- **Drag-and-drop in Avalonia 12**: `DataFormat.CreateInProcessFormat<T>`, `DataTransferItem.Create`, `DataTransfer.Add`, `DragDrop.DoDragDropAsync`, `DragEventArgs.DataTransfer` (not `.Data`). For reordering, manual pointer tracking at window level is simpler.
- **Window-level pointer handler**: `this.AddHandler(PointerPressedEvent, handler, RoutingStrategies.Bubble, handledEventsToo: true)`. Use `IsWithin(source, scrollViewer)` to scope by area; `IsWithinButton(source, stopAt)` with `stopAt` boundary to avoid walking past the container.
- **`StaticResource` vs `DynamicResource`**: themes require `DynamicResource` — `StaticResource` won't update on theme swap. All color brush bindings use `DynamicResource`.
- **Library grid binds to `FilteredLibraryWallpapers`**, not `LibraryWallpapers`. During bulk `LoadLibrary()`, `_suppressFilterUpdate = true`; `UpdateFilteredLibrary()` called once after.
- **Animated GIF cards**: three-layer `Panel` — static JPG (`StaticThumbnailSource`) → static image (`ThumbnailSource`) → animated GIF (`ActiveGifSource`, non-null only when `IsGifActive`). Toggle `IsGifActive` from `PointerEntered/Exited` in code-behind. `AnimatedImageSource` lazy-loaded on first hover.
- **NEVER use `AnimatedImageSourceUri` for remote URLs**: `AnimatedImage.Avalonia`'s URI source does a synchronous `GetStreamAsync(uri).Result` **on the UI thread** inside the `AnimatedSource` property-changed handler. For a grid of remote gifs this froze the app for seconds. Remote path instead: `AnimatedPreviewCache.GetBytesAsync` (async download, off-thread, concurrency-gated, mem+disk cached) → `GifRendererBuilder.TryBuild` (parses + builds the `FrameRenderer` off-thread via the lib's internal `WriteableBitmapFaceFactory`, reached by reflection) → a prebuilt source whose `TryCreate()` returns instantly (`SourceSeekable => null` skips the sync first-frame decode). See `WallpaperCardViewModel.LoadRemoteGifSourceAsync`.
- **Bounded image cache**: `App.Initialize` swaps AsyncImageLoader's default `RamCachedWebImageLoader` (unbounded — every decoded thumbnail kept forever, ~MBs/card on infinite scroll) for `BoundedRamImageLoader` (LRU; evicts by **dropping refs only, never disposing** — a visible control may still hold the bitmap; GC reclaims it).
- **GIF activation is viewport-gated + settle-debounced** (Browse grid): `MainWindow.ReconcileBrowseGifs` animates only cards whose container intersects the viewport (not the larger `ItemsRepeater` realization buffer); `ScheduleGifReconcile` (160ms) suppresses decode during a fast scroll so a fling doesn't decode a full-res preview per card passed. Do **NOT** cap with a process-wide active-gif counter — it leaks when card VMs are discarded (placeholder→real swap, reloads) while `IsGifActive=true`.
- **`AnimatedImage.Avalonia` never disposes `FrameRenderer`** (GC only) and `AnimationStyle` uses it directly (no clone) — do not force-dispose renderers (races the per-tick render loop).

## Theme System

`ThemeService.All` — 31 built-in themes (`AppTheme` record, 15 color fields). `ThemeService.Apply(theme)` writes all 15 into `Application.Current.Resources` as `SolidColorBrush`. Theme persisted in `AppSettings.Theme`. Applied at init in `App.Initialize()` before any window shows.

Color keys: `BgBase`, `BgMantle`, `BgCrust`, `Surface0`–`Surface2`, `TextColor`, `Subtext`, `Muted`, `Accent`, `AccentFg`, `AccentHover`, `Danger`, `DangerBg`, `Success`.

## UI Styling

Button classes: `.accent`, `.ghost`, `.danger`, `.backdrop` (modal overlay, no hover/press feedback). All buttons: `scale(0.96)` press animation (65ms). Hover via `/template/ ContentPresenter#PART_ContentPresenter`. Tab underline: `TabItem:selected /template/ Border#PART_SelectedPipe`.
