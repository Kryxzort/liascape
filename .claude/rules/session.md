---
paths:
  - "src/livepaper/Models/AppSettings.cs"
  - "src/livepaper/Models/LastSession.cs"
  - "src/livepaper/Models/CustomPlaylist.cs"
---

## Settings & Session Persistence

`AppSettings` (JSON at `~/.config/livepaper/settings.json`):
- Playback: `Loop`, `NoAudio`, `DisableCache` (default **false**), `Volume` (0–100), `Speed` (0.1–4.0, default 1.0). Per-item volume/speed overrides live in the library `index.json`, not here (see `library.md`). `VolumeKeyTarget` (`auto` default | `item` | `global`): what the volume keybinds move (`web-backend.md` Live-apply).
- Memory: `DemuxerMaxBytes`, `DemuxerMaxBackBytes` (int, MiB)
- `HwDec`: `"auto"` | `"nvdec"` | `"vaapi"` | `"no"`
- `VideoScale`: `"fill"` (panscan=1.0) | `"fit"` (panscan=0.0); `VideoFps` (0 = native, else caps video playback fps — scenes/LWE unaffected). VideoScale applies **live** (mpv `panscan` via IPC, incl. on advance). **All playback settings apply live now** (`PlayerHelper.ApplyPlaybackSettingsLive`, diffed): `Loop` (loop-file, single video only — the timed machinery owns it under a playlist), `NoAudio` (mpv `aid` / scene LWE mute), `VideoFps` (mpv `vf=fps`), `DisableCache` (`cache`), `DemuxerMax*Bytes`, `HwDec`. Only `LweMonitors` (per-monitor fps/primary) is genuinely launch-only under legacy (LWE has no live reconfigure); under lp-player its fps applies live (`out:<name>.scene_fps`, `player-adapter.md` § Scenes) and primary has no meaning.
- Auto-mute: `AutoMute` (false), `AutoMuteDelayMs` (200), `AutoUnmuteDelayMs` (2000), `AutoMuteThresholdDb` (-70.0), `AutoMuteOnlyIfMprisActive` (false)
- Global rotation: `GlobalIntervalSeconds` (1800), `GlobalAdvanceOnVideoEnd` (false), `GlobalWaitForVideoEnd` (false)
- Restart: `RestartIntervalSeconds` (default 600, min 5, max 3600, clamped in setter; 0 = off); `RestartOnSwitchOnly` (false) — defer the mpvpaper leak-restart to the next playlist changeover (advanced)
- Wallpaper Engine: `WallpaperEnginePath`, `WeCopyFiles`, `ResumeFromLast`, `AllowScenes` (false), `AutoImportWallpaperEngine` (false), `ReplaceDirectWithWorkshop` (false) — swap a direct-DL `workshop/` copy for a `local/` WE-dir symlink when it appears
- Library automation: `AutoAddLibraryToPlaylist` (false) — auto-add new library items to active playlist strip
- LWE: `LweVolume` (100), `LweMonitors` (`{Name, Fps, IsPrimary}[]`), `SceneTransitionDelayMs` (1000)
- UI: `ThumbnailAspect` ("Default"), `CardSize` ("Medium"), `LibrarySortIndex` (5 = newest first), `Theme` ("Catppuccin Mocha")
- Advanced/UI toggles: `AdvancedSettings` (false — reveal power-user rows), `WallpaperBgAllTabs` (false — play the live wallpaper behind Browse/Library too), `DebugMode` (false — `lpdbg` bridge + metrics), `DebugOverlay` (true — on-screen debug HUD when DebugMode is on)
- `LastSession`: tracks last applied mode for `--restore`

`CustomPlaylist` (JSON at `~/.config/livepaper/playlist_state.json` for in-progress; named files in `~/.local/share/livepaper/playlists/`):
- `VideoPaths`, `Name` (nullable; only set after Save or Load)
- `Settings.Order` (Sequential/Shuffle), `Settings.OverrideGlobalSettings`, `Settings.IntervalSeconds`, `Settings.AdvanceOnVideoEnd`, `Settings.WaitForVideoEnd`
- `IntervalSeconds`/`AdvanceOnVideoEnd`/`WaitForVideoEnd` only used when `OverrideGlobalSettings` is true.

`LastSession` model fields:
- `IsPlaylist` — Play All session; `IsTimedPlaylist` — timed playlist; `IsRandom` — `--random` session
- `Paths` — path(s) used; `Shuffle` — shuffle was on
- `TimedIntervalSeconds`, `WaitForVideoEnd`, `AdvanceOnVideoEnd`, `OverrideGlobalSettings` — restores exact interval/mode rather than current globals

**`LastSession` upkeep:** the `/settings` POST merges its body over the saved settings (PATCH — keys it leaves out keep their values, `web-backend.md`) and **preserves** `LastSession` (+ the Steam sign-in: tokens, `SteamId`) from disk whatever the body says (the UI re-POSTs a stale cached copy — clobbering would lose it). `LastSession` is (re)written by `AppOps` on `apply`/`random`/`next`/`PlayPlaylist`; `--restore` replays whatever it last held.

## Timed Playlist

`PlayerHelper.ApplyTimedPlaylist`: `System.Threading.Timer` ticks every 100ms. Decrement uses `DateTime.UtcNow` deltas (no jitter drift). On shuffle, `AdvanceToNext` re-randomizes at end of each cycle with do/while guarantee new cycle's first ≠ old cycle's last. State written to `~/.config/livepaper/timed_state.json` only on significant events (not every tick) — in-memory `_timedRemainingMs` is authoritative.

**Tick lifetime (`EnsureTimedTick`)**: the tick runs the interval AND takes every queued user switch
(pending-action IPC below), so EVERY timed session has one — **whatever its interval** (pure advance-on-end too;
Tick ignores the countdown there) **and whatever its length** — and a list edit that leaves it tickless gets one
(`ReorderPlaylist` — Undo of a trash, a strip add — `AppendToActivePlaylist`, `UpdateTimedSettings`). Every start
site goes through it (null-guarded: no second tick). A live list edit (`takeBack: false`) never restarts it in a
process that `ReleaseTimer`ed. Before: started only at a session (re)start with > 1 item AND interval > 0 → a pure
advance-on-end session never took a next/prev/random (keybind or UI), and a session that started with one item (a
trash leaving one survivor, a one-item playlist played) took nothing — `pending_action.txt` sat untaken while
`/current` said timed, and `StartTimedTimer` discarded it once the list grew (also legacy's leak `restart`).
**A 1-item session** (decided 2026-10-28: a tick for it, not a second consumer of the queue — the tick IS the
queue's one consumer, and only the timer owner may run a switch): a next / random switches to its one item (its
transition included: the strip's "next" after it is itself, the random pool is it), a prev steps back through its
history (the same item; nothing at the session's start), a `restart` relaunches it; it never rotates by itself (`CanRotate` = > 1 item: the interval only starts
over and `PostSwitch` arms no aligned switch to itself, like `ApplyTimedPlaylist`/`RearmAdvanceOnVideoEnd`).
`RestartCurrentAndLaunch` relaunches `PlayingHistoryIndex` (not an advance-on-end session's pre-fetch). Guard:
matrix `seq3:stripRemove+trashUndo+next`, `seq:plPlayAdvanceOnly+next`, `seq:plPlayOne+next|random`.

**Tick state sync**: each tick calls `RefreshSignals()` (re-reads only `TimerStopped`/`TimerPaused`). Owner's `_timedRemainingMs` / history untouched.

**`TimedState` record** fields: `TimerStopped`, `TimerPaused`, `AdvanceOnVideoEnd`, `WaitingForVideoEnd`. On restore, `LoadTimedState` restores `_advanceOnVideoEnd`/`_waitingForVideoEnd`, then `RearmAdvanceOnVideoEnd()` re-arms `DoVideoEndWait`. When `_waitingForVideoEnd=true`, `_historyIndex` is pre-fetched one step ahead — `RestoreTimedPlaylist` adjusts back by one before `SwitchToFile`, then calls `RearmAdvanceOnVideoEnd()`.

**Pending-action IPC** (`~/.config/livepaper/pending_action.txt`): atomic write+rename. Content: `next` / `prev` / `random` / `restart`. Timer owner's tick consumes (read+delete) → `AdvanceAndLaunch` / `StepBackAndLaunch` / `RandomAndLaunch` / `RestartCurrentAndLaunch`. `restart` cold-restarts current wallpaper without advancing and without resetting the countdown. All others call `LaunchAndReset` → kills mpvpaper, launches new, resets `_timedRemainingMs` to full interval.

**Stop/pause signals**:
- `Stop()` → `KillAll()` + `SignalTimerStop()`; daemon's stopped-branch also calls `KillCurrentProcess()` (covers kill→launch race)
- `TogglePause()` → `cycle pause` IPC + flips `TimerPaused`; tick freezes decrement while paused
- `NextWallpaper()`/`PreviousWallpaper()`/`ApplyRandom()` → write `pending_action.txt` if timed playlist active; else mpv `playlist-next`/`playlist-prev` IPC or one-shot random

**Timer ownership**: at most one process owns the timer.
- Daemon writes `timer.pid`; GUI writes `gui_timer.pid` on startup, deletes on close.
- `KillTimerDaemon()` kills orphan daemon (called on GUI startup and inside `SpawnTimerDaemon`).
- `SpawnTimerDaemon()` bails if `IsGuiTimerAlive()`.
- Window-close clears `gui_timer.pid` *before* calling `SpawnTimerDaemon` (enables handoff).

**`IsTimedPlaylistActive()`**: state-file check (`Paths.Count > 0 && !TimerStopped`). Survives brief kill→launch gap.

**`DoVideoEndWait` retry threshold**: 30 iterations (3 s) before breaking on `null` remaining. 500 ms threshold caused premature scene switches.

## WE Auto-Import

`LibraryService.SyncWallpaperEngine(workshopPath, allowScenes, weCopyFiles)` — headless scan of the WE workshop dir. Creates `local/<id>` symlinks + index entries; returns newly-added paths (a video file, or the scene **folder** — scenes are folders now, no `.scene` marker). Called:
- `--serve` startup: `RunHeadlessAutoSync()` off-thread in `ServerHost` (then broadcasts the `library-synced` WS event)
- `--restore`: `RunHeadlessAutoSync()` in `Program.cs` before `PlayerHelper.Restore()`

After sync, if `AutoAddLibraryToPlaylist` is true: `AddCardToPlaylist` for each new item, then `AppendToActivePlaylist` for mid-session injection, and `LastSession.Paths` updated + saved so next `--restore` includes them.
