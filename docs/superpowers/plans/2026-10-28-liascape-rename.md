# Liascape Rename — Plan

**Goal (owner, 2026-10-28):** rename the project to **Liascape** "as if the code base was named [it] from the
start" — every name derived from "livepaper" changes (functions, types, namespaces, files, env vars, paths, units,
packaging), and code names match the UI labels at the same time (one combined rename, one breakage round).

**When:** after the in-flight morph and rotation-redesign branches land on `lp-player`.

## Decisions

- **Name: Liascape** (locked by the owner 2026-10-28). "Lia" = Puck's name for Emilia (Re:Zero), "-scape" = landscape /
  scenery. Checked: free on AUR + GitHub; Google shows only a small florist and an artist's Instagram handle — no game,
  character or software. ("Lumilia" was dropped: it's the full name of Lumi, the protagonist of the desktop game
  *Outcore*.)
- **Command style: one command + subcommands** (git/cargo/podman style). Users only ever type `liascape`:
  - `liascape` — opens the app (GUI); `liascape <action>` replaces `--action=…` (e.g. `liascape next`, `liascape volume up`);
    `liascape restore`, `liascape kill`, `liascape random`; `liascape ctl …` = the player's ctl (state/logs/probe).
  - The real executables live **off PATH** in `libexec/liascape/` with short internal names: the C# backend
    (serve + daemons), the Rust compositor (was `lp-player`), the scene worker (was `lp-scene-worker`), the legacy
    helpers if still present. `liascape` dispatches to them.
- **Code-to-UI names:** every identifier whose UI label differs is renamed to the label (e.g. advance-on-end → the
  rotation labels after the redesign, "strip" → playlist bar, "item modal" → card settings, `LweMonitors` → per-monitor
  scene fps). The agent first produces the UI-label ↔ code-name table, then renames.
- **Paths:** `~/.config/liascape`, `~/.local/share/liascape`, `$XDG_RUNTIME_DIR/liascape`, dev units `liascape-*`, env vars
  `LIASCAPE_*` (was `LP_*`), Electron app id, window title, flake outputs/module, PKGBUILD, `install.sh`, docs and
  `.claude/rules`.
- **No migration code** (owner is the only user): a one-off script moves the owner's config/library/state and rewrites
  renamed keys, run once after merge with a backup.
- **History:** git history is not rewritten.

## Owner steps at the end

1. `/etc/nixos/livepaper.nix` → the new module/flake output (exact edit provided; never committed by Claude).
2. GitHub repo rename `livepaper-pro` → `liascape` (asked separately — public; GitHub redirects the old URL).
3. The Noctalia todo / keybinds / Hyprland config that call `livepaper` (grep provided).

## As built (2026-10-29)

- **Commands.** `liascape` = `scripts/liascape`, a relocatable launcher (bare → Electron on `lib/liascape/shell`;
  `ctl …` → `liascape-player ctl …`; anything else → `liascape-backend`). Backend subcommands: `restore`, `kill`,
  `random`, `next`, `previous`, `play`, `stop`, `toggle-play`, `toggle-pause`, `toggle-mute`, `volume up|down`
  (words joined by `-`: `volume-up` works too), `serve`, internal `monitor-daemon` / `timer-daemon` /
  `restart-daemon`, hidden `player-selftest`; `help`. The `/action` names follow (`next-wallpaper` → `next`).
- **Internal executables** (`<prefix>/libexec/liascape/`, off PATH): `liascape-backend`, `liascape-player`,
  `liascape-scene-worker`, `liascape-transition`, `liascape-audio`. Data in `<prefix>/lib/liascape/`
  (`backend/`, `ui/`, `shell/`, `transitions/`, LWE's core). Same layout from install.sh, the PKGBUILD
  (`liascape-git`), the AppImage and the flake (`packages.<sys>.liascape` = `default`).
- **Code.** `src/backend/liascape-backend.csproj`, namespace `Liascape`; Rust crate `liascape-player`
  (`liascape_player`); `LIASCAPE_*` env vars; PipeWire `liascape-player-bus*` / `liascape-player-scene.<id>`;
  thread names `lia-<role>` (15-byte limit); layer namespace `liascape-player`; Electron productName `Liascape`,
  app id `liascape`; header `X-Liascape-Client`; engine value `liascape-player` (legacy stays `legacy`).
- **Paths.** `~/.config/liascape`, `~/.local/share/liascape`, `~/.local/state/liascape/liascape-player`,
  `~/.cache/liascape`, `$XDG_RUNTIME_DIR/liascape/liascape-player.sock`; Chromium profile `~/.config/liascape-shell`.
- **Dev units** `liascape-vite` / `liascape-watch`, defined in `scripts/dev/*.service`, installed by `scripts/dev.sh`.
- **Code = UI labels.** Settings keys: `VideoFps` → `VideoFpsCap`, `DemuxerMax(Back)Bytes` → `DemuxerMax(Back)Mib`,
  `WallpaperEnginePath` → `WorkshopFolder`, `WeCopyFiles` → `CopyFilesInsteadOfSymlinking`,
  `AutoImportWallpaperEngine` → `AutoAddWeWallpapersToLibrary`, `LweMonitors` → `SceneMonitors`
  (`LweMonitorSettings` → `SceneMonitor`), `KeepPauseOnSwitch` → `StayPausedWhenSwitching`, `WallpaperBgAllTabs` →
  `LiveWallpaperBehindAllTabs`, `TransitionLagOffsetMs` → `FullLiveSyncOffsetMs`, `SceneThrottle` →
  `AutoThrottleScenes`, `SceneVramLimitEnabled` → `LimitVramPerScene`, `WorkshopAcquireMode` →
  `WorkshopDownloadMode`, `(Global)AdvanceOnVideoEnd` → `(Global)SwitchWhenVideoEnds`, `RestartIntervalSeconds` →
  `RestartMpvpaperEverySeconds`, `RestartOnSwitchOnly` → `RestartOnlyAtPlaylistChangeover`, `AutoMuteThresholdDb` →
  `AutoMuteMinLevelDb`, `IsPlaylistCollapsed` → `IsPlaylistBarCollapsed`. The strip → the playlist bar
  (`PlaylistBar`, `.playlist-bar*`, matrix cells `playlistBar*`); the item modal → the card settings modal
  (`CardSettingsModal`, `openCardSettings`). Kept (label differs only by wording/abbreviation, or the name is
  another layer's): `NoAudio` (the player's/mpv's no-audio; "mute" names the user/auto mute), `HwDec`,
  `GlobalIntervalSeconds` (one key under two labels), `GlobalMaxPlaySeconds`, `VramLowMode`, `LweVolume` (legacy
  LWE), the Auto-Mute delays, `NormalizeTargetLufs`.
- **Kept on purpose:** the LWE fork's branch `livepaper/next-v2` (PIN, UPSTREAM.md) and the fork commits' own
  messages (`patches/lwe/*.patch` = the fork's commits; `scripts/lwe.sh verify`), the upstream credit
  (`sunwoo101/livepaper`, LICENSE.upstream-MIT), the git branch `lp-player`, this plan's own text above.
- **Migration:** a one-off `migrate-liascape.sh` (handed to the owner, not committed — no migration code).
