---
paths:
  - "src/backend/Models/AppSettings.cs"
  - "src/backend/Models/LastSession.cs"
  - "src/backend/Models/CustomPlaylist.cs"
---

## Settings & Session Persistence

`AppSettings` (JSON at `~/.config/liascape/settings.json`):
- Playback: `Loop`, `NoAudio`, `DisableCache` (default **false**), `Volume` (0–100), `Speed` (0.1–4.0, default 1.0). Per-item volume/speed overrides live in the library `index.json`, not here (see `library.md`). `VolumeKeyTarget` (`auto` default | `item` | `global`): what the volume keybinds move (`web-backend.md` Live-apply).
- Memory: `DemuxerMaxMib`, `DemuxerMaxBackMib` (int, MiB)
- `HwDec`: `"auto"` | `"nvdec"` | `"vaapi"` | `"no"`
- `VideoScale`: `"fill"` (panscan=1.0) | `"fit"` (panscan=0.0); `VideoFpsCap` (0 = native, else caps video playback fps — scenes/LWE unaffected). VideoScale applies **live** (mpv `panscan` via IPC, incl. on advance). **All playback settings apply live now** (`PlayerHelper.ApplyPlaybackSettingsLive`, diffed): `Loop` (loop-file, single video only — the timed machinery owns it under a playlist), `NoAudio` (mpv `aid` / scene LWE mute), `VideoFpsCap` (mpv `vf=fps`), `DisableCache` (`cache`), `DemuxerMax*Bytes`, `HwDec`. Only `SceneMonitors` (per-monitor fps/primary) is genuinely launch-only under legacy (LWE has no live reconfigure); under liascape-player its fps applies live (`out:<name>.scene_fps`, `player-adapter.md` § Scenes) and primary has no meaning.
- Auto-mute: `AutoMute` (false), `AutoMuteDelayMs` (500), `AutoUnmuteDelayMs` (2000), `AutoMuteMinLevelDb` (-70.0), `AutoMuteOnlyIfMprisActive` (false)
- Global rotation (`player-adapter.md` § Rotation): `GlobalSwitchWhenVideoEnds` (true — "Switch when video ends"), `GlobalIntervalSeconds` (0 — advance-on-end off: "Switch every", a plain timer; on: the **minimum play time**), `GlobalMaxPlaySeconds` (1800 — the maximum under advance-on-end, 0 = off, wall-clock s, clamped 0…359999). Defaults = the old default rotation (each video end, 30 min at most). The "Wait for video to end after interval" toggle (`GlobalWaitForVideoEnd`, `PlaylistWaitForVideoEnd`) and the separate `GlobalMinPlaySeconds` were removed 2026-10-28 — an old file's keys load as unknown ones (no in-app migration; a one-off jq script converted the owner's files)
- Restart: `RestartMpvpaperEverySeconds` (default 600, min 5, max 3600, clamped in setter; 0 = off); `RestartOnlyAtPlaylistChangeover` (false) — defer the mpvpaper leak-restart to the next playlist changeover (advanced)
- Wallpaper Engine: `WorkshopFolder`, `CopyFilesInsteadOfSymlinking`, `ResumeFromLast`, `AllowScenes` (false), `AutoAddWeWallpapersToLibrary` (false), `ReplaceDirectWithWorkshop` (false) — swap a direct-DL `workshop/` copy for a `local/` WE-dir symlink when it appears
- Library automation: `AutoAddLibraryToPlaylist` (false) — auto-add new library items to active playlist bar
- LWE: `LweVolume` (100), `SceneMonitors` (`{Name, Fps, IsPrimary}[]`), `SceneTransitionDelayMs` (1000)
- liascape-player GPU / VRAM (live; `player-adapter.md` § Scenes): `AutoThrottleScenes` (true), `LimitVramPerScene` (false) + `SceneVramLimitMib` (1536, 64–1048576), `VramLowMode` (`stop` | `pause` | `off`)
- UI: `ThumbnailAspect` ("Default"), `CardSize` ("Medium"), `LibrarySortIndex` (5 = newest first), `Theme` ("Catppuccin Mocha")
- Advanced/UI toggles: `AdvancedSettings` (false — reveal power-user rows), `LiveWallpaperBehindAllTabs` (false — play the live wallpaper behind Browse/Library too), `DebugMode` (false — `liascapeDbg` bridge + metrics), `DebugOverlay` (true — on-screen debug HUD when DebugMode is on)
- `LastSession`: tracks last applied mode for `liascape restore`

`CustomPlaylist` (JSON at `~/.config/liascape/playlist_state.json` for in-progress; named files in `~/.local/share/liascape/playlists/`):
- `VideoPaths`, `Name` (nullable; only set after Save or Load)
- `Settings.Order` (Sequential/Shuffle), `Settings.OverrideGlobalSettings`, `Settings.IntervalSeconds` (0; the timer, or the minimum play time under advance-on-end), `Settings.SwitchWhenVideoEnds` (true), `Settings.MaxPlaySeconds` (0 = off), `Settings.SeparateSceneTiming` (true) + `Settings.SwitchScenesAfterSeconds` (1800) — "Separate timing for scenes" / "Switch scenes after" (player-adapter.md § Rotation)
- `IntervalSeconds`/`SwitchWhenVideoEnds`/`MaxPlaySeconds`/`SeparateSceneTiming`/`SwitchScenesAfterSeconds` only used when `OverrideGlobalSettings` is true. The maximum and the scene timing are NOT in `LastSession`: a session reads it from the current playlist state + settings at its start / restore / resume (like the transitions); the minimum is the session's own interval.

`LastSession` model fields:
- `IsPlaylist` — Play All session; `IsTimedPlaylist` — timed playlist; `IsRandom` — `random` session
- `Paths` — path(s) used; `Shuffle` — shuffle was on
- `TimedIntervalSeconds` (the timer, or the minimum under advance-on-end), `SwitchWhenVideoEnds`, `OverrideGlobalSettings` — restores exact interval/mode rather than current globals

**`LastSession` upkeep:** the `/settings` POST merges its body over the saved settings (PATCH — keys it leaves out keep their values, `web-backend.md`) and **preserves** `LastSession` (+ the Steam sign-in: tokens, `SteamId`) from disk whatever the body says (the UI re-POSTs a stale cached copy — clobbering would lose it). `LastSession` is (re)written by `AppOps` on `apply`/`random`/`next`/`PlayPlaylist`; `--restore` replays whatever it last held.

## Timed Playlist

`PlayerHelper.ApplyTimedPlaylist`: `System.Threading.Timer` ticks every 100ms. Decrement uses `DateTime.UtcNow` deltas (no jitter drift). On shuffle, `AdvanceToNext` re-randomizes at end of each cycle with do/while guarantee new cycle's first ≠ old cycle's last. State written to `~/.config/liascape/timed_state.json` only on significant events (not every tick) — in-memory `_timedRemainingMs` is authoritative.

**Tick lifetime (`EnsureTimedTick`)**: the tick runs the interval AND takes every queued user switch
(pending-action IPC below), so EVERY timed session has one — **whatever its interval** (pure advance-on-end too;
Tick has no countdown there) **and whatever its length** — and a list edit that leaves it tickless gets one
(`ReorderPlaylist` — Undo of a trash, a playlist bar add — `AppendToActivePlaylist`, `UpdateTimedSettings`). Every start
site goes through it (null-guarded: no second tick). A live list edit (`takeBack: false`) never restarts it in a
process that `ReleaseTimer`ed. Before: started only at a session (re)start with > 1 item AND interval > 0 → a pure
advance-on-end session never took a next/prev/random (keybind or UI), and a session that started with one item (a
trash leaving one survivor, a one-item playlist played) took nothing — `pending_action.txt` sat untaken while
`/current` said timed, and `StartTimedTimer` discarded it once the list grew (also legacy's leak `restart`).
**A 1-item session** (decided 2026-10-28: a tick for it, not a second consumer of the queue — the tick IS the
queue's one consumer, and only the timer owner may run a switch): a next / random switches to its one item (its
transition included: the playlist bar's "next" after it is itself, the random pool is it), a prev steps back through its
history (the same item; nothing at the session's start), a `restart` relaunches it; it never rotates by itself (`CanRotate` = > 1 item: the interval only starts
over and `PostSwitch` arms no aligned switch to itself, like `ApplyTimedPlaylist`/`RearmSwitchWhenVideoEnds`).
`RestartCurrentAndLaunch` relaunches `PlayingHistoryIndex` (not an advance-on-end session's pre-fetch). Guard:
matrix `seq3:playlistBarRemove+trashUndo+next`, `seq:plPlayAdvanceOnly+next`, `seq:plPlayOne+next|random`.

**Tick state sync**: each tick calls `RefreshSignals()` (re-reads only `TimerStopped`/`TimerPaused`). Owner's `_timedRemainingMs` / history untouched.

**`TimedState` record** fields: `TimerStopped`, `TimerPaused`, `SwitchWhenVideoEnds`, `WaitingForVideoEnd`. Also `IntervalSeconds` (the timer / the minimum), `ItemPlayedMs` + `PlayedSavedAtMs` (the playing item's play time for the minimum / maximum; loaded + the time since the save unless paused). An older file's `WaitForVideoEnd` is ignored. On restore, `LoadTimedState` restores `_switchWhenVideoEnds`/`_waitingForVideoEnd`, then `RearmSwitchWhenVideoEnds()` re-arms `DoVideoEndWait`. When `_waitingForVideoEnd=true`, `_historyIndex` is pre-fetched one step ahead — `RestoreTimedPlaylist` adjusts back by one before `SwitchToFile`, then calls `RearmSwitchWhenVideoEnds()`.

**Pending-action IPC** (`~/.config/liascape/pending_action.txt`): atomic write+rename. Content: `next` / `prev` / `random` / `restart`. Timer owner's tick consumes (read+delete) → `AdvanceAndLaunch` / `StepBackAndLaunch` / `RandomAndLaunch` / `RestartCurrentAndLaunch`. `restart` cold-restarts current wallpaper without advancing and without resetting the countdown. All others call `LaunchAndReset` → kills mpvpaper, launches new, resets `_timedRemainingMs` to full interval.

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

`LibraryService.SyncWallpaperEngine(workshopPath, allowScenes, copyFilesInsteadOfSymlinking)` — headless scan of the WE workshop dir. Creates `local/<id>` symlinks + index entries; returns newly-added paths (a video file, or the scene **folder** — scenes are folders now, no `.scene` marker). Called:
- `serve` startup: `RunHeadlessAutoSync()` off-thread in `ServerHost` (then broadcasts the `library-synced` WS event)
- `liascape restore`: `RunHeadlessAutoSync()` in `Program.cs` before `PlayerHelper.Restore()`

After sync, if `AutoAddLibraryToPlaylist` is true: `AddCardToPlaylist` for each new item, then `AppendToActivePlaylist` for mid-session injection, and `LastSession.Paths` updated + saved so next `--restore` includes them.
