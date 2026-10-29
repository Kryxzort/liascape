# DRAFT — "Game running" signal (mute / pause the wallpaper while a game runs)

**Status:** draft, not planned. Owner, 2026-10-29: "save a draft for it now, we'll plan better later".
To be folded into Phase 3 (next to pause-when-covered, Task 14's auto-mute) when it's planned properly.

## Why
Pause-when-covered (Phase 3, O1) already pauses for a fullscreen/maximized game covering every wallpaper
monitor. This adds the cases it misses: a windowed/borderless game, a game on another monitor.

## Detection (a player Signal `game.running`, live, works with the app closed)
- **Steam / Proton:** a `reaper` process whose cmdline carries `SteamLaunch AppId=<n>`. A cheap `/proc` scan
  (≈ 1–2 s cadence, cmdline only for new pids). No per-game config.
- **Feral GameMode:** `com.feralinteractive.GameMode` on the session bus — `ClientCount` property + the
  `GameRegistered` / `GameUnregistered` signals (event-driven, no polling). Lutris, Heroic, many launchers.
- **gamescope:** a `gamescope` process running.
- **Optional extra list:** user-entered process names (native games launched by hand). Open question.

## Action (open question for the owner)
"While a game is running": **Pause** (frees the GPU — suggested default) | **Mute** | Off. Possibly the pause
variant also stops scene workers (VRAM) — decide with the VRAM-low-mode semantics (Stop / Pause).

## Composition to check when planned
- With pause-when-covered (both pausing → one resume when both clear), user pause/mute (a user pause survives
  the game ending; toggle-mute semantics as Task 14 criterion 6), auto-mute (a game's audio would also trigger
  auto-mute — the game signal shouldn't double-count), rotation (does a paused-for-game wallpaper hold its
  rotation timer? likely yes, like a user pause), transitions mid-switch, restore.
- The Steam scan must exclude Steam's own client processes (only `reaper … AppId=` counts).

## Open questions
1. Default action: Pause vs Mute.
2. Extra process-name list: yes / no.
3. Where the setting lives: Auto-Mute section vs a new "Gaming" group.
