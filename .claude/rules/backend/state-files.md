---
paths:
  - "src/backend/Models/AppSettings.cs"
  - "src/backend/Models/LastSession.cs"
  - "src/backend/Models/CustomPlaylist.cs"
  - "src/backend/Models/SceneMonitor.cs"
  - "src/backend/Helpers/SettingsService.cs"
  - "src/backend/Helpers/PlaylistService.cs"
  - "src/backend/Helpers/AtomicFile.cs"
  - "src/backend/Helpers/FileLock.cs"
  - "src/backend/Helpers/JsonMerge.cs"
  - "scripts/test-settings-merge.sh"
  - "scripts/test-cross-process.sh"
---

# Settings, sessions and other shared state files

Files: `~/.config/liascape/settings.json` (`AppSettings`), `playlist_state.json` (the playlist bar, `CustomPlaylist`),
named playlists in `~/.local/share/liascape/playlists/`, per-source library `index.json` (`.claude/rules/backend/library.md`).
The CLI, the daemons, `serve` and the player-side processes all read and write them concurrently.

## Writing
- Every settings write is field-level: `SettingsService.Update(s => s.Field = …)` or `Patch`. `Save` is private; never load, change and save a whole copy (it reverts what another writer saved meanwhile).
- Compute a step (a volume key's +5) INSIDE the mutate from what's saved, never from an earlier load. Guard: `scripts/test-cross-process.sh`.
- Write shared files atomically (`AtomicFile.WriteAllText`: temp + rename) and read them with a retried parse (`AtomicFile.ReadJson`). Never write a shared state file in place — a torn read loads C# defaults and the next save writes them back. Guards: matrix `race:settingsSaveLoad`, `race:playlistSaveLoad`, `race:indexSaveLoad`.
- Cross-process locking: `FileLock` (`flock` on `<file>.lock`) inside the in-process lock (`PatchLock` for settings).
- Formats may change freely before the first release (`CLAUDE.md` § Hard rules): no migration or compatibility code. A removed setting's key loads as an unknown one and disappears on the next save.

## Secrets
- `settings.json` holds no secrets. The Steam sign-in's tokens live in `Helpers/SecretStore.cs` (keyring, else `steam-auth.json`; `.claude/rules/backend/sources-steam.md`). `AppSettings` keeps the old token keys only for reading (`Legacy*`), and `SecretStore` moves them out.
- `GET /settings` returns `SettingsService.Redacted`; `settings.json` and `steam-auth.json` are 0600.

## Settings semantics that aren't obvious from the model
- Per-item volume/speed overrides live in the library index, not in settings (absent = follow the global).
- `SettingsLevel` (basic | standard | advanced | expert) is UI-only; the backend never reads it, and hiding a setting never resets it.
- Rotation fields (`Global*` and `PlaylistSettings.*`, used only when `OverrideGlobalSettings`): semantics in `.claude/rules/backend/player-adapter.md` § Rotation.
- `PauseWhenCovered`, `GlobalPlaylistStart` / `PlaylistStart`, `RotateWhileParked`, the GPU/VRAM settings and `SceneMonitors` fps are liascape-player props, all live.
- `RestartMpvpaperEverySeconds` and `RestartOnlyAtPlaylistChangeover` are legacy only.

## `LastSession`
- Written by `AppOps` on apply / random / next / play-playlist; replayed by `liascape restore` (under liascape-player only when the player shows nothing).
- `POST /settings` preserves `LastSession` from disk whatever the body says (the UI posts a stale copy).
- The maximum play time and scene timing are not in `LastSession`; a session reads them from the current playlist state + settings at start / restore.
