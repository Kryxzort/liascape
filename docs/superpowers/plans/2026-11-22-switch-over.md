# Switch-Over Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Decision.** liascape-player becomes the only engine now. The owner waived the rest of the switch-over bar on
2026-11-22: "even with issues, it's better than the previous engine". There is no separate spec. `docs/TODO.md`
§ Queued, item 0 "The switch-over, now", is the authority, with `docs/player/reports/switch-over.md` § 5 as its
background. Open bar items (frozen-onset micro-gaps, the 8 h soak, the crash-isolation re-run) no longer block. A
regression they find later is a bug to fix, never a reason to bring legacy back. Starts after #114 lands (TODO).

**Goal:** remove the legacy engine (mpvpaper, the backend's linux-wallpaperengine launcher, `src/native/`), make the
restored wallpaper wait for its source's `Ready`, then rewrite the last upstream livepaper code and drop
`LICENSE.upstream-MIT`.

**Architecture:** first a flip that makes legacy unreachable while its code still compiles
(`PlayerEngine.IsLiascapePlayer` always answers `true`). Then the dead branches go, layer by layer: UI, backend rotation,
backend media, native and packaging, on-machine tools, docs. Each task deletes the tests, probe cells, rule bullets
and decision entries of the code it deletes, so the app builds and every suite passes after each task. The seam fix
and the upstream rewrite come after, on a backend that has one engine.

**Tech Stack:** C# (.NET 10) backend, React/TypeScript UI with an Electron shell, Rust player, Nix flake,
`scripts/install.sh`, `scripts/PKGBUILD`.

**Spec:** `docs/TODO.md` § Queued item 0 (the switch-over), `docs/superpowers/plans/2026-10-28-upstream-code-rewrite.md`
(the rewrite's rules), `docs/player/reports/switch-over.md` § 5 (the start-up seam call).

## Global Constraints

- Features compose (CLAUDE.md § Hard rules). Every task lists the modes it touches and verifies them: apply / playlist
  (timed, advance-on-end) / random / restore / stop × video, scene, preset × transitions on and off × paused.
- Settings apply live at `override ?? global`. After Task 4 no setting is launch-only, and CLAUDE.md says so.
- Tests are hermetic. Never start, stop or reconfigure the owner's app, player, settings or library. A test that ran
  "the legacy engine, so no player" must now point `LIASCAPE_PLAYER_BIN` at a stub (Task 1). It must never let a real
  player start.
- Pre-release: no compatibility or migration code. A removed setting loads as an unknown key and disappears on the
  next save (`.claude/rules/backend/state-files.md`). The one exception is Task 1's transitional reap, deleted in
  Task 4.
- Shared state files stay field-level and atomic (`SettingsService.Update` / `Patch`).
- A deletion carries its citations. Remove every `Guard:` comment, CLAUDE.md line, rule bullet, `docs/decisions.md`
  entry and TODO line that names a deleted script, cell or function in the same commit. `bash scripts/check-rules.sh`
  is clean after every task.
- A change to something `README.md` says updates `README.md` (and `docs/README-next.md` until Task 5 swaps them) in the
  same commit.
- Code comments say why, never history: no "used to run legacy", no dates.
- Runs (daytime): per-area only. Use one suite, one `--probe probe-<area>.js`, or one nextest filter, through the test
  lock (`scripts/test-*.sh` take it themselves; anything else goes through `bash scripts/test-lock.sh …`). Run anything
  over ~30 s in the background. The full UI matrix (`bash scripts/test-ui-matrix.sh`), the full player suite and
  `nix build .#liascape` run at night, once per landed batch: after Task 4, after Task 7 and after Task 11.
- Before every commit: `dotnet build src/backend` (once the task touches the backend), `cd app/ui && npm run build &&
  npm run lint` (once it touches the UI), `bash scripts/test-ui-matrix.sh --changed` (UI or probes), and
  `bash scripts/check-rules.sh`.
- Commits: a short title-case title with no period. The body holds the story. Add one `Claude-Agent: <model id>,
  effort <…>, <role>` trailer per Claude that wrote the commit (the hook checks both). Stage files by name. No push.

## Review Focus

1. **The owner's own settings.** Their `settings.json` says `"PlayerEngine": "legacy"` and carries legacy keys
   (`RestartMpvpaperEverySeconds`, `SceneMonitors[].isPrimary`, …), and a legacy session (mpvpaper, LWE, a
   `timer-daemon`, `timed_state.json`) may still be running when the new build starts. The first `serve` / `restore`
   on the new build must show the session on liascape-player, with no second wallpaper left on screen, and the next
   save must drop the dead keys. Test: Task 1, `scripts/test-player-binary.sh` § "a legacy settings file".
2. **Tests that meant "no player".** Hermetic scripts that set `"PlayerEngine":"legacy"` to keep the player away
   (item-actions, cache-clear, folder-import, steam-signin, steam-app-hold, library-facts, preview-backfill,
   clip-sweep, cross-process) must still never start a real `liascape-player serve`. Test: Task 1, each script points
   `LIASCAPE_PLAYER_BIN` at an `exit 1` stub, and `test-player-binary.sh` asserts that an apply with the stub spawns
   no `serve`.
3. **A missing or late player binary.** Examples: a fresh install that never built the player, or a store path that
   appears after boot. With no fallback left, `/apply` must answer with the binary's reason (never a silent black
   screen), `GET /player-engine` and the health summary must say why, and once the binary appears the next apply must
   play without restarting the app. The old engine-heal test covered this. Test: Task 1, `test-player-binary.sh`
   § "missing" and § "appears later".
4. **A restore that waits for `Ready`.** A backend `restore` (boot, autostart) that asks the player what it shows
   during the wait must not replay `LastSession` over the restored wallpaper, and `/current` must name it. Test:
   Task 8, `restore_pending_layer_counts_as_shown` (api.rs) and an adapter-IT check.
5. **A switch or stop before `Ready`.** A user switch or stop that arrives while a restored layer waits wins: the
   restored source never pops in afterwards. Test: Task 8, `restore_pending_is_cancelled_by_a_switch`.

---

## Inventory

Counted on `lp-player` at `16cabc6f`, excluding `third_party/`, `spikes/` and `docs/player/reports/` (dated data: never
edit). "Delete" = legacy-only, the whole thing goes. "Simplify" = shared code that loses its legacy branch.

| Area | Delete | Simplify | Task |
|---|---|---|---|
| Engine switch | `PlayerEngine.Wants` / `WouldBeLiascapePlayer` / `Refresh` / `HealIfFound`, `PlayerHelper.SwitchEngineLive` / `SwitchEngineNow`, `AppSettings.PlayerEngine`, the `/settings` engine diff (`Web/ServerHost.cs:492-503`), `scripts/test-engine-heal.sh` (replaced by `test-player-binary.sh`) | `PlayerEngine.cs` (208) → `Player/PlayerStatus.cs` (resolver, scene / VRAM status, `Status()`) | 1, 4 |
| Rotation (legacy tick) | `PlayerHelper` timer / restart daemons, `timed_state.json`, `pending_action.txt`, `Tick`, `EnsureTimedTick`, `DoVideoEndWait` (its player branch is dead behind `LegacyRotationReached`), `HoldForMinPlay`, `RunTimerDaemon`, `RunRestartDaemon`, `LoadFromTimedState`, `LegacyRotationReached`, `RetiredUnderPlayer`; `Program.cs` verbs `timer-daemon`, `restart-daemon`; `AppSettings.RestartMpvpaperEverySeconds` / `RestartOnlyAtPlaylistChangeover` | `Apply`, `ApplyPlaylist`, `ApplyTimedPlaylist`, `Restore`, `Stop`, `TogglePause`, `UpdateTimedSettings`, `NextWallpaper` / `PreviousWallpaper`, `ReorderPlaylist`, `LiascapePlayerProgram.Startup` | 3 |
| Media (legacy launch) | `PlayerHelper` mpvpaper / LWE launch and IPC (`SwitchToFile`'s legacy body, `Launch`'s, `TryIpcSwitchToFile`, `SpawnLweProcesses`, `LaunchScene`, the `GetLwe*` / `ApplyLwe*` / `RunPactl` / `Bake*` / `NormalizeAf` helpers, `AudioCtl`, `CorrectSceneVolume`, `SendOverlayCtl`, the reapers, `IsLweAvailable`, playlist observer); `TransitionService.TryStart` and its overlay / capture / ffmpeg / mpv helpers and `ResolveBinary`; `AudioMonitor` `monitor-daemon` + LWE stream classing; `AppSettings` `BuildMpvOptions` / `BuildMpvPlaylistOptions` / `BuildLweOptions` / `LweVolume` / `SceneTransitionDelayMs` / `FullLiveSyncOffsetMs`, `SceneMonitor.IsPrimary`; `/mpv-preview`, `/lwe-preview`; `Presets.PresetProblem.Legacy` / `LegacyReason`; `SceneProperties`' `--set-property` encoder | every `IsLiascapePlayer` site (≈70: `PlayerHelper`, `AppOps`, `ServerHost`, `LiascapePlayerProgram`, `LiascapePlayerMedia`, `AudioMonitor`, `FeatureHealth`, `PreviewBackfill`, `PresetDownloads`, `LibraryService`, `SteamWorkshopService`), the `mpvOptions` parameter everywhere, `MonitorDetector` (drops the `liascape-transition --list-outputs` step), `LiascapePlayerSelfTest` (truth tables lose the legacy column) | 4 |
| UI | the "Player engine" row, "Restart legacy player every (s)", "Only restart between wallpapers", "Scene transition delay (ms)", the scene monitor "primary" radio, "Full-live sync nudge", the "mpv command" and "linux-wallpaperengine command" sections, `api.mpvPreview` / `lwePreview`, `PRESET_LEGACY`, `libraryFollowsEngine` | `views/Settings.tsx`, `store/index.ts` (`presetsOn`, `unplayableReasonOf`, `libKeyOf`, defaults), `settingsLevel.ts`, `components/LibrarySide.tsx` (`sceneSpeed`), `views/Library.tsx`, `api/client.ts` types, `index.css` comments | 2 |
| Probes | cells `nudge:engine`, `levels:noEmptySection:legacy`, `lib:preset:legacy`, matrix `noop:restartEvery`, `noop:restartAtChangeover` | `preview:monitors` (asserts on the deleted LWE command: re-target it to `/settings`' saved monitors or delete), `levels:rows`, `lib:scenesBlocked` and `ws:presetsHidden` (lose their legacy halves), probe-matrix's settings-save cell (`playerEngine` field), probe-health comment | 2 |
| Native and packaging | `src/native/` (2 helpers, ≈3,400 lines with protocol XML), flake derivations `liascape-transition` / `liascape-audio` and runtime deps `mpvpaper` / `linux-wallpaperengine`, PKGBUILD / `.SRCINFO` optdepends, `.gitignore` lines, `scripts/dev.sh` make lines | `scripts/install.sh` (native loop, preflight, help), `scripts/liascape` (helper env), `flake.nix` devShell, `scripts/agent-window.sh` (engine pin), `UserScope.cs` comment, `transitions/README.md` | 5 |
| Tests and tools | `scripts/test-legacy-launch.sh` (Task 1), `scripts/liascape_audiowatch.py`, `scene_corpus.sh --ab-legacy` + its report half (ambiguous, below) | `test-liascape-player-adapter.sh` (engine-switch section, the legacy-files watch, the `timed_state.json` takeover), `test-settings-merge.sh`, `test-presets.sh`, `test-workshop-social.sh`, `test-folder-import.sh`, `test-steam-signin.sh` + `test-fixtures/drive-steam-client.mjs` (the preset `LEGACY` expectations), `test-settings-latency.sh` / `test-ui-matrix.sh` (keys), on-machine `battery.sh`, `bus.sh`, `outputs.sh`, `programs.sh` (mpvpaper stops, `legacy_daemons`) | 1, 3, 4, 6 |
| Rules and docs | `.claude/rules/backend/legacy-engine.md`; `docs/decisions.md` § Legacy engine (9 entries; "Monitor auto-mute per stream with a 10 ms parec latency" moves to § Backend/API, because `AudioMonitor` stays); `README.md` → replaced by `docs/README-next.md`; the README-next line in `writing-rules.md` | CLAUDE.md (intro, live-settings rule, two verify lines, rule table row), `player-adapter.md`, `state-files.md`, `library.md`, `ui/state-and-api.md`, `build-and-packaging.md`, `docs/player/{architecture,adapter,invariants}.md`, `docs/player/modules/{sources,audio-bus}.md`, `docs/TODO.md` (#88, § Switch-over bar, § Legacy player, packaging sub-item, stray legacy sub-items) | 1–7 |
| Stays (looks legacy, isn't) | `transitions/` (the player's catalogue), `TransitionService.Config` / `Effective` / `Pick*` / `Manifest` / `ComposedFragment` / `ResolveDir`, `TransitionMethod`, `MonitorDetector` (`/monitors`), `MpvPropertyMap`, `AudioMonitor`'s in-`serve` monitor (a player without the `automute` capability), `scripts/measure-automute-latency.py`, `src/player/tests/automute.rs`' `Legacy` emulation of it, the LWE core + `patches/lwe/` (the scene renderer; "livepaper" there is the fork branch name), mpvpaper's rows in `CREDITS.md` / `UPSTREAM.md` (techniques the player uses) | — | — |

Size: about 75 files touched and 14 deleted outright. Roughly 8,000 lines go: `PlayerHelper.cs` ≈2,800 of 4,464,
`src/native/` ≈3,400, `TransitionService.cs` ≈450, tests and tools ≈1,200, UI and probes ≈350, flake / install /
PKGBUILD ≈100, docs and rules ≈500 net. Upstream livepaper lines left (`git blame -w -M -C`, braces / `using` / blank
lines excluded): 956, with 376 of them in `PlayerHelper.cs`, mostly in legacy code that Tasks 3–4 delete.

### Rulings this plan made (the session may overturn them)
- `GET /player-engine` keeps its path and drops `engine` / `active`. Renaming it touches about 30 scripts for no user
  gain.
- `AudioMonitor` stays as the in-`serve` auto-mute for a player without the `automute` capability
  (`player-adapter.md` § Auto-mute). Only `monitor-daemon` and LWE stream classing go.
- `scripts/liascape_audiowatch.py` is deleted. The Rust dropout probe that ports it rewords its "port of" comments
  (git keeps the file).
- `SceneMonitors` stays (per-output scene fps is live in the player). `IsPrimary` goes.
- The transitional reap of a running legacy session lives from Task 1 to Task 4 (Review Focus 1).

### Ambiguous: needs the session's ruling
- `scene_corpus.sh --ab-legacy` compares scenes against an installed upstream `linux-wallpaperengine`, not the app's
  engine. Default here: delete it with its report half (`scene_we_compare.sh` against WE itself stays). Keep it only if
  the owner still wants upstream-LWE A/Bs.
- The fork acknowledgement once the rewrite reaches 0. TODO says the README's fork line goes. The rewrite plan offers a
  history note in `UPSTREAM.md` ("started as a fork of sunwoo101/livepaper; no upstream code remains") instead of none.
  Default here: keep that one-line note in `UPSTREAM.md` (→ `CREDITS.md`).
- Landing on the owner's machine. If their install jumps from a pre-Task-1 build straight to a post-Task-4 build, the
  transitional reap never runs. The session should then ask the owner to run `liascape stop` on the old build first.

---

### Task 1: Make liascape-player The Only Engine

Legacy becomes unreachable. Its code still compiles and gets deleted by later tasks.

**Files:**
- Modify: `src/backend/Player/PlayerEngine.cs` (`IsLiascapePlayer` → `public static bool IsLiascapePlayer => true;`, a
  temporary marker for Tasks 2–4 — a property, not a `const`, so the dead branches don't raise CS0162; delete `Wants`, `WouldBeLiascapePlayer`, `Refresh`, `HealIfFound`,
  `_isPlayer`; `Status()` drops `engine` / `active`)
- Modify: `src/backend/Models/AppSettings.cs:177-180` (delete `PlayerEngine`)
- Modify: `src/backend/Helpers/PlayerHelper.cs:2982-3028` (delete `SwitchEngineLive` / `SwitchEngineNow`)
- Modify: `src/backend/Web/ServerHost.cs:492-503` (no engine diff); `ServerHost.cs:131` serve start: after
  `KillLegacyDaemons()`, call `PlayerHelper.ReapAllWallpaperProcs()` (make it `internal`) — the transitional reap
- Modify: `src/backend/Helpers/FeatureHealth.cs` (the `liascape-player` row links no setting; `onPlayer` = true)
- Modify: `app/ui/src/views/Settings.tsx:763-779` (delete the "Player engine" row only; the engine state hook keeps
  reading `/player-engine` for `scenes` / `vram`)
- Modify: `README.md` (drop "Two players", "with liascape-player" qualifiers, mpvpaper mentions that are now false)
- Modify: `CLAUDE.md` (intro sentence, the engine-heal and legacy-launch verify lines → one `test-player-binary.sh` line)
- Create: `scripts/test-player-binary.sh` (from `scripts/test-engine-heal.sh`'s hermetic setup)
- Delete: `scripts/test-engine-heal.sh`, `scripts/test-legacy-launch.sh` (first move any assertion that still holds
  under the player into `test-presets.sh` or the adapter IT: its § presets "a playlist of unplayable presets plays
  nothing and says why")
- Modify: the scripts of Review Focus 2 (`"PlayerEngine":"legacy"` → removed, `LIASCAPE_PLAYER_BIN=$T/bin/liascape-player`
  pointing at `printf '#!/bin/sh\nexit 1\n'`, the `test-folder-import.sh:388` pattern); `test-presets.sh` § 1,
  `test-workshop-social.sh:317`, `test-folder-import.sh:469`, `test-steam-signin.sh` / `drive-steam-client.mjs`
  (`LEGACY` → what the stub player gives: the preset is playable, the apply fails on the stub — assert that reason),
  `test-settings-merge.sh:605-610`, `test-liascape-player-adapter.sh:2885-2895` (engine switch)
- Modify: `Guard:` comments naming the deleted scripts (`PlayerHelper.cs`, `AudioMonitor.cs`, `AppOps.cs`, `PlayerEngine.cs`)
- Modify: `docs/decisions.md` (new entry under § Player: "Make liascape-player the only engine, no fallback —
  2026-11-22": a missing binary is an error with its reason, never a legacy fallback; enforced by
  `test-player-binary.sh`)

**Interfaces:**
- Produces: `PlayerEngine.IsLiascapePlayer` (always `true`, deleted in Task 4); `GET /player-engine` →
  `{available, binary, running, scenes, vram, reason}`; `PlayerHelper.ReapAllWallpaperProcs()` internal (deleted in Task 4).

- [ ] **Step 1: Write `scripts/test-player-binary.sh`** (hermetic: temp HOME + XDG, private backend, no Wayland, its
  own stub or debug player). Sections and assertions:
  - § "a legacy settings file": `settings.json` = `{"PlayerEngine":"legacy","RestartMpvpaperEverySeconds":600,"SceneMonitors":[{"name":"X-1","fps":30,"isPrimary":true}]}`
    with the real debug player and `LIASCAPE_PLAYER_SOCKET` private → `GET /player-engine` has no `engine` / `active`;
    an `/apply` of a fixture video starts exactly one `serve` (its pid under `$XDG_RUNTIME_DIR`), `GET /current` names
    the video; no `mpvpaper` process with this run's `HOME` in its environment; after one `POST /settings {"Volume":70}`
    the file has no `PlayerEngine` key.
  - § "missing": `LIASCAPE_PLAYER_BIN=$T/bin/absent` → `/player-engine.available == false`, `.reason` contains
    "liascape-player binary not found"; `/apply` answers non-2xx with that reason; `GET /health/features` lists
    `liascape-player` as missing.
  - § "appears later": copy the debug player to `$T/bin/absent`; the next `/apply` (no backend restart) plays within 10 s.
  - § "stub never plays": with the `exit 1` stub, `/apply` starts no `serve` (`pgrep -f "$T/bin/liascape-player serve"` empty).
- [ ] **Step 2: Run it on the base build, show RED**
  Run: `LIASCAPE_PB_DLL=<base build dll> bash scripts/test-player-binary.sh --no-build` (the script takes another build's dll
  through `LIASCAPE_PB_DLL`, as `test-engine-heal.sh` did with `LIASCAPE_EH_DLL`) (base = `lp-player` built in a worktree)
  Expected: FAIL in § "a legacy settings file" (`active: legacy`, nothing on the player) and § "missing" (legacy answered the apply)
- [ ] **Step 3: Implement the flip** (files above). Resolve the binary fresh on every `EnsureRunning` that finds none
  cached (`ResolveBinary(fresh: true)` when the cache is null), so § "appears later" needs no heal loop.
- [ ] **Step 4: Run it GREEN, then the suites it touches**
  Run: `bash scripts/test-player-binary.sh`; `bash scripts/test-settings-merge.sh`; `bash scripts/test-presets.sh`;
  `bash scripts/test-folder-import.sh`; `bash scripts/test-steam-signin.sh`; `bash scripts/test-item-actions.sh`;
  `bash scripts/test-cache-clear.sh`; `bash scripts/test-workshop-social.sh`;
  `LIASCAPE_IT_ONLY=presets bash scripts/test-liascape-player-adapter.sh`; `bash scripts/test-ui-matrix.sh --probe probe-settings.js`
  Expected: each `RESULT … fail=0`
- [ ] **Step 5: Verify compose** — the player-selftest and the full adapter IT (one background run):
  `bash scripts/test-liascape-player-adapter.sh`. Expected: fail=0 (restore × single / playlist / timed, auto-mute
  open and closed).
- [ ] **Step 6: Commit** — `Make liascape-player The Only Engine`

### Task 2: Remove The Legacy Engine From The UI

**Files:**
- Modify: `app/ui/src/views/Settings.tsx` (delete the rows and sections listed in the Inventory; `liascapeActive` /
  `legacyActive` go and the player rows always show; the scenes `<Help>` reads `engine.scenes` unconditionally; the
  `/mpv-preview` / `/lwe-preview` effects go)
- Modify: `app/ui/src/store/index.ts` (`presetsOn` = `!!settings?.allowScenes`; `unplayableReasonOf` loses the legacy
  branch and `PRESET_LEGACY`; `libKeyOf` = scene support only; defaults lose `playerEngine`, `restartMpvpaperEverySeconds`,
  `restartOnlyAtPlaylistChangeover`, `sceneTransitionDelayMs`, `fullLiveSyncOffsetMs`)
- Modify: `app/ui/src/settingsLevel.ts:31-35`, `components/LibrarySide.tsx:84-85,368`, `views/Library.tsx:66-73`,
  `components/LibraryCard.tsx:22,54`, `api/client.ts:295-303,278`, `index.css:470,783` (comments)
- Modify: `app/shell/probe-settings.js`, `probe-sidebar.js`, `probe-steam.js`, `probe-matrix.js`, `probe-health.js`
  (the cells in the Inventory)
- Modify: `.claude/rules/ui/state-and-api.md:34-52` (bullets that describe per-engine behaviour)

**Interfaces:**
- Consumes: Task 1's `/player-engine` shape (no `engine` / `active`).

- [ ] **Step 1: Rewrite the assertions that cover changed behaviour** (no new cells: this task removes UI).
  `lib:scenesBlocked` keeps only its liascape-player half. `ws:presetsHidden` keeps "scene support off". `levels:rows`
  drops the moved legacy rows from its table. `levels:noEmptySection` runs once (no `${engine}` loop). Delete
  `nudge:engine`, `lib:preset:legacy`, `noop:restartEvery`, `noop:restartAtChangeover`. `preview:monitors` asserts that
  removing a scene monitor saves `sceneMonitors` without it (read `/settings`), since the command block is gone.
- [ ] **Step 2: Remove the UI code** (files above). No new element, so the design checklist only needs "nothing
  left behind": a section that loses all its rows loses its heading (`Section` already handles this).
- [ ] **Step 3: Verify**
  Run: `cd app/ui && npm run build && npm run lint`; `bash scripts/test-ui-matrix.sh --probe probe-settings.js`;
  `--probe probe-sidebar.js`; `--probe probe-steam.js`; `--probe probe-health.js`; `bash scripts/test-ui-matrix.sh --changed`
  Expected: clean build and lint; every listed probe fail=0; screenshots of Settings at Basic and Expert show no empty
  section.
- [ ] **Step 4: Commit** — `Remove The Legacy Engine From The UI`

### Task 3: Remove The Legacy Rotation Machinery

Under the player, rotation runs in `prog:main`. Everything `LegacyRotationReached` guards is dead.

**Files:**
- Modify: `src/backend/Helpers/PlayerHelper.cs` (delete the rotation rows of the Inventory; `Apply` / `ApplyPlaylist` /
  `ApplyTimedPlaylist` keep only their player bodies; `Restore` = `RestoreOnPlayer`; `KillLegacyDaemons` stays until
  Task 4 as part of the transitional reap)
- Modify: `src/backend/Program.cs:69-81` (delete `timer-daemon`, `restart-daemon`; `monitor-daemon` goes in Task 4)
- Modify: `src/backend/Player/LiascapePlayerProgram.cs:212-219` (no `timed_state.json` takeover)
- Modify: `src/backend/Web/ServerHost.cs:120-166,542` (timer handoff, restart-setting diff), `AppOps.cs:54-94`
- Modify: `src/backend/Models/AppSettings.cs` (delete `RestartMpvpaperEverySeconds`, `RestartOnlyAtPlaylistChangeover`)
- Modify: `scripts/test-liascape-player-adapter.sh:167-175,1744-1755,2880-2883` (the legacy-files watch and the takeover
  section go); `scripts/test-settings-merge.sh`, `test-settings-latency.sh`, `test-ui-matrix.sh` (drop the dead keys)
- Modify: `.claude/rules/backend/legacy-engine.md` (delete § Timed playlist and § Restart daemon), `player-adapter.md`
  § Program wiring (no `RetiredUnderPlayer` / timer-file bullets), `state-files.md` (the restart bullet),
  `docs/decisions.md` (delete "Give a one-item timed session a tick…", "Restart mpvpaper periodically…",
  "Give `DoVideoEndWait` 3 s…"), `docs/TODO.md` (the advance-on-end "Legacy engine: … minimum hold" sub-item)

**Interfaces:**
- Produces: `PlayerHelper.ApplyTimedPlaylist(IReadOnlyList<string> paths, string mpvOptions, bool shuffle, int intervalSeconds, bool switchWhenVideoEnds)`
  unchanged in signature (Task 4 drops `mpvOptions`).

- [ ] **Step 1: Pin what must survive.** The adapter IT already covers rotation on the player (§ advance-on-end
  play-time limits, restore, backend restart, 1-item playlist, keep-playing). Add one check to the adapter IT:
  "a `pending_action.txt` / `timed_state.json` left in the config dir is ignored, never read". Plant both before
  `serve`, then assert that the session plays `LastSession` and that `/current` is not the planted item. RED on
  Task 2's build (the takeover reads `timed_state.json`).
- [ ] **Step 2: Delete the machinery.** Use the compiler as the guide: delete, then fix every caller that now fails to
  build. Never leave a method whose only caller is gone.
- [ ] **Step 3: Verify**
  Run: `dotnet build src/backend`; `LIASCAPE_PLAYER_BIN=src/player/target/debug/liascape-player dotnet run --project src/backend -- player-selftest`;
  `bash scripts/test-liascape-player-adapter.sh` (background); `bash scripts/test-settings-merge.sh`;
  `bash scripts/test-cross-process.sh`; `bash scripts/test-backend-stop.sh`; `bash scripts/test-ui-matrix.sh --probe probe-matrix.js`
  (the rotation cells: run it in the background, it is the biggest area)
  Expected: build clean; selftest PASS; each suite fail=0. Compose: timed × transitions × paused × restore, all
  through the adapter IT's sections.
- [ ] **Step 4: Commit** — `Remove The Legacy Rotation Machinery`

### Task 4: Remove The Legacy Media Path

**Files:**
- Modify: `src/backend/Helpers/PlayerHelper.cs` (the media rows of the Inventory, `ReapAllWallpaperProcs`,
  `KillLegacyDaemons`, every `IsLiascapePlayer` branch: keep the player side)
- Modify: `src/backend/Helpers/TransitionService.cs` (keep `Config`, `Effective`, `SameConfig`, `CurrentConfig`, `Pick`,
  `PickEffect`, `PickDuration`, `ComposeFragment` / `ComposedFragment`, `VertSource`, `PreviewImagePath`, `EffectExists`,
  `Manifest`, `ResolveDir`, `TransLog`; delete the rest)
- Modify: `src/backend/Helpers/AudioMonitor.cs` (delete `RunDaemon`, `SpawnDetachedMonitor`, `KillDetachedMonitor`, the
  LWE client-id classing); `Program.cs` (`monitor-daemon` verb); `MonitorDetector.cs:42-50`
- Rename: `src/backend/Player/PlayerEngine.cs` → `src/backend/Player/PlayerStatus.cs`, `class PlayerStatus` with
  `ResolveBinary(bool fresh = false)`, `UnavailableReason`, `ScenesPlayable(AppSettings)`, `SceneStatus(AppSettings)`,
  `VramStatus(AppSettings)`, `SceneUnavailableReason(AppSettings)`, `Status()`; `IsLiascapePlayer` is gone
  (`ScenesPlayableFor` loses its engine parameter: `(bool allowScenes, Func<bool> liascapeScenes)`)
- Modify: `AppSettings.cs` (the Inventory's media fields), `SceneMonitor.cs` (`IsPrimary`), `ServerHost.cs:199-201,590,596,637`,
  `AppOps.cs:188-214,402,419,541-563`, `Presets.cs` (`StatusOf(string path)`, no engine argument),
  `SceneProperties.cs:334-410`, `FeatureHealth.cs`, `PreviewBackfill.cs:425`, `PresetDownloads.cs`, `LibraryService.cs:535`,
  `SteamWorkshopService.cs`, `LiascapePlayerProgram.cs`, `LiascapePlayerMedia.cs`, `LiascapePlayerClient.cs`,
  `SceneLoudnessOps.cs`, `SceneLoudnessPlanner.cs`, `LiascapePlayerSelfTest.cs`; drop the `mpvOptions` parameter from
  `PlayerHelper.Apply` / `ApplyPlaylist` / `ApplyTimedPlaylist` and their callers
- Modify: the scripts' `jq -r .active` guards ("refusing to touch any legacy player": delete them) in
  `test-liascape-player-adapter.sh`, `test-settings-merge.sh`, `test-settings-latency.sh`, `test-presets.sh`,
  `test-folder-import.sh`
- Delete: `.claude/rules/backend/legacy-engine.md`. Move first: § Mute and auto-mute's `parec` bullets that still hold
  for `AudioMonitor` → `player-adapter.md` § Auto-mute; § Transition catalogue → `.claude/rules/player/runtime-api.md`
  (add `transitions/**` to its `paths`). Delete its CLAUDE.md table row.
- Modify: CLAUDE.md "Settings apply live" ("no setting is launch-only"), `library.md:47,53,99`, `state-files.md`
  (the `SceneMonitors` bullet), `build-and-packaging.md:51` and `docs/player/adapter.md:37-39,63` (`PlayerStatus.ResolveBinary`;
  "Missing → … legacy works" → "Missing → every apply fails with the reason")
- Modify: `docs/decisions.md` (delete § Legacy engine's remaining entries and heading; move "Monitor auto-mute per stream
  with a 10 ms parec latency" to § Backend/API); `docs/TODO.md` (delete § "Legacy player (current app) — small fixes")

**Interfaces:**
- Consumes: Task 3's player-only `Apply…` bodies.
- Produces: `Liascape.Player.PlayerStatus` (above); `PlayerHelper.Apply(string path)`, `ApplyPlaylist(IReadOnlyList<string> paths, bool shuffle = false, int intervalSeconds = 0)`,
  `ApplyTimedPlaylist(IReadOnlyList<string> paths, bool shuffle, int intervalSeconds, bool switchWhenVideoEnds = false)`;
  `Presets.StatusOf(string path)`.

- [ ] **Step 1: Rewrite the assertions whose behaviour changes.** `GET /library/{scene}/props` (AppOps:188) answers
  without `engine` / `note`. A preset's reason never reads "Presets play only in the Liascape player": grep the tests
  for that string and for "linux-wallpaperengine not found" and rewrite each. Self-test `ScenesPlayableFor` drops its
  legacy rows.
- [ ] **Step 2: Delete and simplify** (files above). After this task, `grep -rn "IsLiascapePlayer\|mpvpaper\|liascape-transition\|liascape-audio\|SpawnLwe\|IsLweAvailable" src/backend`
  prints nothing.
- [ ] **Step 3: Verify**
  Run: `dotnet build src/backend`; the player-selftest (as in Task 3); `bash scripts/test-liascape-player-adapter.sh`
  (background); `bash scripts/test-player-binary.sh`; `bash scripts/test-presets.sh`; `bash scripts/test-settings-merge.sh`;
  `bash scripts/test-settings-latency.sh`; `bash scripts/test-backend-stop.sh`; `bash scripts/test-ui-matrix.sh --probe probe-health.js`;
  `bash scripts/check-rules.sh`
  Expected: fail=0 everywhere; the grep above empty; check-rules clean. Compose: transitions × V→V / V→S / S→V / S→S
  × timed / advance-on-end / manual / random / restore (adapter IT); every setting live (settings-latency, settings-merge).
- [ ] **Step 4: Night run** (the session): the full UI matrix and the full player suite on the Task 1–4 batch.
- [ ] **Step 5: Commit** — `Remove The Legacy Media Path`

### Task 5: Drop The Native Helpers And Swap The README

**Files:**
- Delete: `src/native/` (both helpers, `protocol/`); `.gitignore:15-20`
- Modify: `flake.nix` (runtime deps lines 22-27: `mpvpaper`, `linux-wallpaperengine` go, `mpv` stays only if
  `runtimeTools` still needs it; derivations 115-147; links 278-279; `packages` 318-319; devShell 342-343; comments
  211-212, 334)
- Modify: `scripts/install.sh` (header layout line 23; the native loop 153-165; the preflight 91-120 checks exactly what
  the player and the scene worker build, matching README-next's toolchain table; drop `make` / `wayland-scanner` /
  `libpulse` / `xkbcommon` only after checking what still links them with `ldd` on the built `liascape-player` and
  `liascape-scene-worker`)
- Modify: `scripts/PKGBUILD` + `scripts/.SRCINFO` (optdepends; `libpulse` stays as long as `AudioMonitor` calls
  `pactl` / `parec`; regenerate with `makepkg --printsrcinfo`), `scripts/liascape:9-10,31`, `scripts/dev.sh:14-16`,
  `scripts/agent-window.sh:242-246`, `scripts/dev/liascape-watch.service:14`, `transitions/README.md:4`,
  `src/backend/Helpers/UserScope.cs:25`
- Move: `docs/README-next.md` → `README.md` (drop its header comment; check every relative link exists)
- Modify: `.claude/rules/writing-rules.md` (delete the README-next line under "Where a new fact goes"),
  `docs/TODO.md` (§ Switch-over bar's README sub-item; the Packaging sub-item's "drop the optdepends" half: keep
  "publish to the AUR")

- [ ] **Step 1: Verify the layout before** — `bash scripts/install.sh --dry-run > "$T/before.txt"` (any scratch folder of the task's own)
- [ ] **Step 2: Remove and simplify** (files above)
- [ ] **Step 3: Verify**
  Run: `bash scripts/install.sh --dry-run` (diff against before: only the two helpers gone);
  `nix eval .#packages.x86_64-linux.liascape.drvPath` (the flake evaluates); `cd scripts && makepkg --printsrcinfo | diff - .SRCINFO`;
  `bash scripts/check-rules.sh`; `bash scripts/test-player-binary.sh` (the backend never looks for a helper);
  `bash scripts/test-backend-stop.sh`
  Expected: diff = the two libexec entries only; eval prints a path; `.SRCINFO` in sync; fail=0. Night (the session):
  `bash scripts/test-lock.sh nix build .#liascape` and a staged `install.sh` into a temp `DESTDIR`, then
  `ldd` on every ELF shows nothing missing.
- [ ] **Step 4: Commit** — `Drop The Native Helpers And Swap The README`

### Task 6: Retire The Legacy On-Machine Tools

**Files:**
- Delete: `scripts/liascape_audiowatch.py`; `scene_corpus.sh` `--ab-legacy` / `--legacy-*` / `run_legacy` and
  `scene_corpus_report.py`'s legacy section (if the session keeps the default ruling)
- Modify: `src/player/tests/onmachine/battery.sh:103-120,479-488,607-609,650,692` (no `stop_legacy_wallpaper`, no
  engine restore dance), `bus.sh:113-121`, `outputs.sh:19,199-200`, `programs.sh:336` (`legacy_daemons`), `scenes_steps.sh`,
  `.claude/rules/player/scenes.md:248`
- Modify: `src/player/src/probe/dropout.rs:2,38,246,288,805`, `src/player/tests/dropout.rs:2,494` (cite the
  reference algorithm as the `refcheck` they port, without the deleted path), stray "legacy" comments in
  `src/player/src/{runtime.rs,sources/mpv.rs,audio/bus.rs}`, `tests/{api.rs,sources.rs}` (say what the behaviour is,
  not "as legacy did")

- [ ] **Step 1: Edit** (files above). On-machine scripts are owner-run, never during the day.
- [ ] **Step 2: Verify**
  Run: `bash -n` on every changed `.sh`; `python3 -I -m py_compile src/player/tests/onmachine/scene_corpus_report.py`;
  `bash scripts/test-lock.sh env -u LD_LIBRARY_PATH nix develop -c cargo nextest run --manifest-path src/player/Cargo.toml -E 'binary(dropout)'`;
  `bash scripts/check-rules.sh`
  Expected: no syntax errors; dropout tests pass; check-rules clean. The comment-only Rust edits are proven by a
  comment-stripped diff (`.claude/rules/testing.md` § A red result).
- [ ] **Step 3: Commit** — `Retire The Legacy On-Machine Tools`

### Task 7: Close The Switch-Over In The Docs

**Files:**
- Modify: `docs/player/architecture.md:7-9,110-116` (the player is the only engine; § Not built loses the switch-over),
  `docs/player/invariants.md:10,54,135-138` (keep the why, drop the engine name where it is history),
  `docs/player/modules/audio-bus.md:49`, `docs/player/modules/sources.md:119` (mpvpaper stays as the technique's credit)
- Modify: `docs/superpowers/plans/2026-11-17-multi-monitor-v1.md`, `docs/superpowers/specs/2026-11-17-multi-monitor-design.md`,
  `docs/superpowers/specs/2026-10-29-rules-recon.md` (lines that assume legacy exists)
- Modify: `docs/TODO.md` (delete #88; delete § Switch-over bar's first item and its README sub-item; trim item 0 to
  its (b) and (c); stray legacy sub-items: Phase 3 "monitor-daemon is retired", health follow-ups)
- Modify: `CREDITS.md` / `UPSTREAM.md` only where a row names a deleted file (regenerate `CREDITS.md` with
  `scripts/gen-credits.py` if `UPSTREAM.md` changes)

- [ ] **Step 1: Sweep.** `grep -rniE "legacy|mpvpaper|PlayerEngine|liascape-transition|liascape-audio" CLAUDE.md .claude docs README.md --exclude-dir=reports --exclude-dir=spikes`.
  Every hit either names something that still exists (a credit, the fork branch) or goes.
- [ ] **Step 2: Verify** — `bash scripts/check-rules.sh` clean; the sweep's remaining hits listed in the commit body
  with why each stays.
- [ ] **Step 3: Night run** (the session): the full UI matrix and the full player suite on the Task 5–7 batch.
- [ ] **Step 4: Commit** — `Close The Switch-Over In The Docs`

### Task 8: Hold A Restored Layer Until Its Source Is Ready

The owner's pick from `switch-over.md` § 5: the restored wallpaper's layer waits for its source's first frame, as a
switch's B does. Today `Runtime::restore_snapshot` (`src/player/src/runtime.rs:3999-4110`) sets
`lay:<c>:main.content` at once, and the seam probe counted 4 frames per output at start-up.

**Files:**
- Modify: `src/player/src/runtime.rs` (`restore_snapshot`, `drive_onsets` ≈2143, `current_wallpaper` ≈3227, the
  `set` / `transition` / `stop` command paths), `src/player/src/snapshot.rs` (`capture` ≈341 takes the pending shows)
- Test: `src/player/tests/supervise.rs` (restore runs there: `crash_restores` ≈454), `src/player/tests/api.rs`
  (the seam helpers `seam_totals` ≈11946)
- Modify: `docs/player/modules/persistence.md` (restore waits for `Ready`), `docs/TODO.md` (item 0 (b) and
  § Switch-over bar's "Seam probe at start-up")

**Interfaces:**
- Produces: `Runtime.pending_show: BTreeMap<String /*source id*/, BTreeSet<String> /*connector*/>`. An entry is filled
  by `restore_snapshot` instead of the immediate `set`. It is resolved in `drive_onsets` on `SourceEvent::Ready` (set
  each connector's `lay:<c>:main.content`) and dropped on `SourceEvent::Error` (the layer stays empty; the
  broken-source path decides what shows). A connector's entry is dropped when a command changes that layer (a
  `transition`, `stop`, a `set lay:<c>:main.content`) or its output goes. `current_wallpaper()`, the `cur:` alias,
  `state`'s outputs (a `pending` field) and `snapshot::capture` treat a pending connector as showing its source.

- [ ] **Step 1: Write the failing tests** (stub scene worker with `LIASCAPE_SCENE_WORKER_TEST=load_busy_ms:800`, so
  `Ready` comes late):
  - `restore_waits_for_ready_no_seam`: a scene on screen, quit (snapshot), `serve --restore` → every output's
    `seam_frames == 0` through the first second after `Ready`, and `lay:<c>:main.content` becomes the source only
    after `source.ready`.
  - `restore_pending_layer_counts_as_shown`: before `Ready`, `get cur:*.path` is the scene's path and `state` reports
    the output's `pending`.
  - `restore_pending_survives_a_snapshot`: a snapshot written before `Ready` still names the source on that output.
  - `restore_pending_is_cancelled_by_a_switch`: a `transition` to a video before `Ready` → the video shows, and after the
    scene's `Ready` the layer still shows the video.
  - `restore_pending_dropped_on_error`: a scene whose worker exits (`exit_code:3`) → the layer stays empty, no content
    set, `source.broken` logged.
  - `restore_paused_still_shows_first_frame`: `player.paused` true in the snapshot → the content is set at `Ready`.
- [ ] **Step 2: Run them to verify they fail**
  Run: `bash scripts/test-lock.sh env -u LD_LIBRARY_PATH nix develop -c cargo nextest run --manifest-path src/player/Cargo.toml -E 'test(/^restore_/)'`
  Expected: FAIL (seam frames counted; content set before `Ready`)
- [ ] **Step 3: Implement** `pending_show` as in Interfaces.
- [ ] **Step 4: Run them GREEN, then the neighbours**
  Run: the same filter; then `-E 'binary(supervise)'`, `-E 'binary(api) and test(/seam|restore|snapshot/)'`, `-E 'binary(program)'`
  Expected: PASS. Compose: restore × parked × session-start (`start_over` never shows the old item) × hot-plugged output
  (all in `supervise.rs` / `program.rs`).
- [ ] **Step 5: Backend half** — the adapter IT gains "a `restore` during the restored layer's wait does not replay
  `LastSession`". Use the stub-worker scene, `serve --restore`, then `liascape restore`, and assert that
  `/current` stays the scene and that `spawned.log` shows no second switch. Run `bash scripts/test-liascape-player-adapter.sh`.
- [ ] **Step 6: Night** (the session): the on-machine seam probe (`scenes.sh`) reports 0 start-up seam frames.
- [ ] **Step 7: Commit** — `Hold A Restored Layer Until Its Source Is Ready`

### Task 9: Rewrite The Scrapers

From here the upstream rewrite plan's rules bind: a real rewrite from behaviour, behaviour pinned by tests first, git
history untouched.

**Files:**
- Re-measure: the blame count script in the commit body (`git blame -w -M -C --line-porcelain`, author `Sun Woo Kim`,
  excluding blank, brace-only and `using` / `namespace` lines) over `src/`, `app/`, `scripts/`
- Rewrite: `src/backend/Scrapers/{MotionBgsScraper,MoewallsScraper,DesktophutScraper,WallpaperEngineScraper}.cs`,
  `src/backend/Services/{MotionBgsService,MoewallsService,DesktophutService,WallpaperEngineService,IBgsProvider}.cs`,
  `src/backend/Models/{WallpaperDetail,WallpaperResult}.cs`
- Create: `scripts/test-fixtures/scrapers/<site>/{search,detail}.html` (trimmed to the elements the parser reads: never
  whole pages) and a `scraper-selftest` backend verb (`src/backend/Scrapers/ScraperSelfTest.cs`) that parses each
  fixture and compares it with `expected.json`

**Interfaces:**
- Produces: the same public surface the routes in `Web/ServerHost.cs` and `Services/WebSourcesFixture.cs` use. Do not
  build the "More wallpaper sources" interface (TODO backlog) here.

- [ ] **Step 1: Pin** — capture fixtures, write `expected.json` from today's parser output, add
  `dotnet run --project src/backend -- scraper-selftest`. It passes on the old code (it pins behaviour) and must fail
  on a deliberately broken selector (show that once).
- [ ] **Step 2: Rewrite** each file from its fixtures and its callers, not from its old lines.
- [ ] **Step 3: Verify** — `scraper-selftest` PASS; the blame count for these files = 0;
  `bash scripts/test-ui-matrix.sh --probe probe-steam.js` (Browse's web sources, through `WebSourcesFixture`).
- [ ] **Step 4: Commit** — `Rewrite The Scrapers`

### Task 10: Rewrite The Remaining Upstream Code

**Files:**
- Rewrite: what the Task 9 count still lists. Expected: `Helpers/ImportService.cs`, `Helpers/DownloadHelper.cs`,
  `Helpers/PlaylistService.cs`, `Helpers/AudioMonitor.cs`, `Models/AppSettings.cs`, `Program.cs`, `Models/LastSession.cs`,
  `Models/LibraryItem.cs`, `Models/CustomPlaylist.cs`, `HttpClientProvider.cs`, `Helpers/{SettingsService,LibraryService,UserScope,MonitorDetector}.cs`,
  `Web/AppOps.cs`, `PlayerHelper.cs`'s survivors, `scripts/{build-appimage.sh,install.sh,PKGBUILD}`. Split this task
  in two at the session's call if the count is over ~400 lines.

- [ ] **Step 1: Pin** — each file's behaviour is covered before its rewrite. Imports and downloads:
  `test-folder-import.sh`, `test-steam-signin.sh`. Playlists and settings: `test-settings-merge.sh`,
  `test-cross-process.sh`, the matrix `race:*` cells. Auto-mute: adapter IT § automute. Packaging:
  `install.sh --dry-run`, the AppImage script's `--help`. Where nothing covers a behaviour, add the check first and show
  it RED against a broken build.
- [ ] **Step 2: Rewrite** file by file. Run that file's suites after each one.
- [ ] **Step 3: Verify** — the count over `src/`, `app/`, `scripts/` = 0 non-trivial lines; every suite named in
  Step 1 fail=0; `dotnet build src/backend`; `bash scripts/check-rules.sh`.
- [ ] **Step 4: Commit** — `Rewrite The Remaining Upstream Code`

### Task 11: Drop The Upstream MIT License

**Files:**
- Delete: `LICENSE.upstream-MIT`; `docs/superpowers/plans/2026-10-28-upstream-code-rewrite.md`; this plan
- Modify: `README.md` (the fork sentence in its license paragraph), `scripts/PKGBUILD:95` + `license=('GPL-3.0-only')`
  + `.SRCINFO`, `UPSTREAM.md` (the history note, per the ruling above) → `scripts/gen-credits.py` regenerates
  `CREDITS.md`, `docs/TODO.md` (delete item 0 and the rewrite sub-item of § Switch-over bar)

- [ ] **Step 1: Gate** — re-run the Task 9 count over the whole tree: 0, or stop.
- [ ] **Step 2: Remove and update** (files above); move still-true facts from both plans to their homes
  (`writing-rules.md` § Where a new fact goes).
- [ ] **Step 3: Verify** — `bash scripts/check-rules.sh`; `grep -rn "upstream-MIT" .` prints nothing outside
  `docs/player/reports/`; `makepkg --printsrcinfo | diff - .SRCINFO`. Night (the session): full UI matrix, full player
  suite, `nix build .#liascape`.
- [ ] **Step 4: Commit** — `Drop The Upstream MIT License`
