# CLAUDE.md

Liascape is a live-wallpaper manager for Wayland: an Electron + React UI (`app/`) over a headless C# backend
(`src/backend/`, the CLI, daemons and a loopback web API). Wallpapers play in `liascape-player`, a Rust compositor
(`src/player/`), or under the legacy engine (`PlayerEngine=legacy`) in mpvpaper + linux-wallpaperengine + C helpers (`src/native/`).
Users type one command, `liascape` (`scripts/liascape`): bare = the app, `liascape <command>` = the CLI, `liascape ctl …` = the player's socket.

## Verify your work
Every command below is hermetic unless marked; run anything over ~30 s in the background.
- Backend build: `dotnet build src/backend`
- UI build + lint: `cd app/ui && npm run build && npm run lint`
- Player tests: `cd src/player && env -u LD_LIBRARY_PATH nix develop -c cargo test -q` (this machine's shell carries a stray `LD_LIBRARY_PATH` that breaks native links)
- UI matrix: `bash scripts/test-ui-matrix.sh --changed` before a commit, the full run before a merge; one area: `--probe <app/shell/probe-*.js>` (skill `ui-verify`)
- Adapter integration test: `bash scripts/test-liascape-player-adapter.sh [--no-build]`
- Adapter self-test: `LIASCAPE_PLAYER_BIN=src/player/target/debug/liascape-player dotnet run --project src/backend -- player-selftest`
- Settings merge / cross-process writes / settings latency: `bash scripts/test-settings-merge.sh`, `bash scripts/test-cross-process.sh`, `bash scripts/test-settings-latency.sh`
- Steam paths (no account needed): `bash scripts/test-steam-signin.sh`
- Rules and docs: `bash scripts/check-rules.sh`
- Dev stack (NOT hermetic — the owner's session): `bash scripts/dev.sh` / `bash scripts/dev-stop.sh`
- Inspect a running player (read-only): `liascape ctl state|logs|probe` (skill `player-debug`)

## Hard rules
- Features compose: every feature keeps working alongside every other one it can co-occur with. Fix the interaction; never disable one behind another. Only a demonstrable hard limit excuses an incompatibility — say so explicitly. After building something, list the modes it touches and verify each combination (e.g. transitions × timed / advance-on-end / manual / random / restore × V→V, V→S, S→V, S→S).
- Settings apply live: a change takes effect on the playing wallpaper at once, at its effective value (`override ?? global`). Wire a new setting's live path too; the only launch-only settings are legacy LWE's (`SceneMonitors`, scene properties).
- Tests are hermetic: own HOME / XDG dirs, backend, player socket and audio server. Never start, stop, restart or reconfigure the owner's running app, player, settings, library or keyring from a test or an experiment.
- Never print, log or commit secrets: never `cat` `~/.config/liascape/settings.json` or `~/.config/liascape/steam-auth.json`, the API token (`serve.token`), or keyring values. Steam tokens live in `src/backend/Helpers/SecretStore.cs` (keyring, else `steam-auth.json`), never in settings.json.
- Shared state files (settings, playlist state, library `index.json`) are written field-level and atomically: `.claude/rules/backend/state-files.md`.
- Never break a CLI command or flag, or a state-file format: an old file must still load.
- Every new UI element follows the app's design and its toggles (theme, glow / `no-glow`, motion / `no-motion`, translucency / `bg-live`, themed controls, a probe): the checklist at the top of `.claude/rules/ui/design.md`. Put it in every UI agent's brief.
- Commit messages: short, title-case, no period (`Fix App Name`, `Add Shuffle Toggle`).

## Where the rule for X lives
Path-scoped rules load when you read or edit matching files; open one directly when your task touches its area.

| area | rule file |
|---|---|
| writing rules, docs, skills | `.claude/rules/writing-rules.md` |
| build, install, flake, PKGBUILD, AppImage, launcher, dev stack | `.claude/rules/build-and-packaging.md` |
| backend web API, security, WS events, feature health | `.claude/rules/backend/api.md` |
| settings, sessions, atomic state files | `.claude/rules/backend/state-files.md` |
| library, index, loudness, scene properties, trash | `.claude/rules/backend/library.md` |
| scrapers, Workshop, Steam sign-in, secrets, downloads | `.claude/rules/backend/sources-steam.md` |
| C# side of liascape-player; rotation semantics | `.claude/rules/backend/player-adapter.md` |
| legacy engine (mpvpaper, LWE, `liascape-transition`, `liascape-audio`) | `.claude/rules/backend/legacy-engine.md` |
| Rust player: core invariants, graph, clocks, snapshot, supervisor | `.claude/rules/player/core.md` |
| Rust player: EGL, Wayland, composition | `.claude/rules/player/gfx-wayland.md` |
| Rust player: sources, mpv, audio bus | `.claude/rules/player/sources-audio.md` |
| Rust player: transitions, programs, signals, runtime, command API | `.claude/rules/player/runtime-api.md` |
| Rust player: scenes, scene worker, LWE core | `.claude/rules/player/scenes.md` |
| UI look, motion, controls, performance | `.claude/rules/ui/design.md` |
| UI store and backend API use | `.claude/rules/ui/state-and-api.md` |
| Electron shell, probes, UI matrix | `.claude/rules/ui/shell-and-probes.md` |

## Reference docs (read on demand)
- `docs/player/architecture.md` (the player's design), `docs/player/invariants.md`, `docs/player/debugging.md`, `docs/player/modules/` (per-module walkthroughs), `docs/player/adapter.md` (the C# adapter's walkthrough).
- `docs/history/` — what happened and why: the old rule files with their incidents, measurements and owner decisions (`docs/history/README.md` maps old rule paths that code comments still cite).
- Status and to-do: `docs/TODO.md` (done items: `docs/TODO-done.md`).
