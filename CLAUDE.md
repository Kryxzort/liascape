# CLAUDE.md

Liascape is a live-wallpaper manager for Wayland: an Electron + React UI (`app/`) over a headless C# backend
(`src/backend/`, the CLI and a loopback web API). Wallpapers play in `liascape-player`, a Rust compositor
(`src/player/`), the only engine.
Users type one command, `liascape` (`scripts/liascape`): bare = the app, `liascape <command>` = the CLI, `liascape ctl …` = the player's socket.

## Verify your work
Every command below is hermetic unless marked; run anything over ~30 s in the background. Heavy runs queue on one
machine-wide lock (`scripts/test-lock.sh`, `.claude/rules/testing.md` § One heavy run at a time).
- Backend build: `dotnet build src/backend`
- UI build + lint (both clean; keep them clean before every commit): `cd app/ui && npm run build && npm run lint`
- Player tests: `bash scripts/test-lock.sh env -u LD_LIBRARY_PATH nix develop -c cargo nextest run --manifest-path src/player/Cargo.toml` (one process per test, hung tests killed, flaky ones retried and reported as FLAKY: `src/player/.config/nextest.toml`; this machine's shell carries a stray `LD_LIBRARY_PATH` that breaks native links)
- UI matrix: `bash scripts/test-ui-matrix.sh --changed` before a commit, the full run before a merge; one area: `--probe probe-<area>.js` (the bare file name, from `app/shell/`) (skill `ui-verify`)
- Adapter integration test: `bash scripts/test-liascape-player-adapter.sh [--no-build]`
- Adapter self-test: `LIASCAPE_PLAYER_BIN=src/player/target/debug/liascape-player dotnet run --project src/backend -- player-selftest`
- Browse's sources against saved pages, and their downloads into a private library (no network): `dotnet run --project src/backend -- scraper-selftest`
- Settings merge / cross-process writes / settings latency: `bash scripts/test-settings-merge.sh`, `bash scripts/test-cross-process.sh`, `bash scripts/test-settings-latency.sh`
- liascape-player the only engine (a legacy settings file and session, a missing binary, one that appears later, the tests' stub): `bash scripts/test-player-binary.sh`
- Steam paths (no account needed): `bash scripts/test-steam-signin.sh`; how long "Use the Steam app" stays connected: `bash scripts/test-steam-app-hold.sh`
- The item sidebars' Workshop favourite / comments / creator / counts and Browse's Workshop lists (a fake community server, no network): `bash scripts/test-workshop-social.sh`
- Library tags, trailers, frame sizes and sizes on disk (no network, fake Steam servers): `bash scripts/test-library-facts.sh`
- Presets: their base scene, layered properties, the base's delete (fake Steam servers, no network): `bash scripts/test-presets.sh`
- Preview clips following "Video preview quality" (debounce, up / down, cancel, restart): `bash scripts/test-clip-sweep.sh`
- Previews made ahead of their cards (on-screen first, failures remembered, the hold, restart, live preview settings): `bash scripts/test-preview-backfill.sh`
- Browse's card pictures from Steam's image CDN (a fake CDN and a slow DNS; one download per card's still and gif, one lookup, a left page's downloads stopped, timed with a bound): `bash scripts/test-card-pictures.sh`
- `serve` exits within 3 s of SIGTERM (idle, an open page's WebSocket, playing, a stalled /media download, the clip sweep, a Steam session open): `bash scripts/test-backend-stop.sh`
- The sidebar's crash-mark Clear and "open in your default app" (a stub xdg-open; what /open/media refuses): `bash scripts/test-item-actions.sh`
- Folder import and watched folders (the scan, link / copy, live pickup, removals; sources never touched): `bash scripts/test-folder-import.sh`
- Settings' cache clear (per-category sizes, 400s, nothing outside the ticked folders deleted): `bash scripts/test-cache-clear.sh`
- The hidden cards' file (field-level, atomic, across processes and restarts; Hide's Undo): `bash scripts/test-hidden.sh`
- The shell's dev mode only on Liascape's own Vite, never another server on its port: `bash scripts/test-vite-detect.sh`
- The UI matrix's per-cell limit, whole-run ceiling and lock release (a cell that never answers; SIGTERM / SIGKILL of a run): `bash scripts/test-matrix-watchdog.sh [--no-build]`
- Liascape's own Electron where the system has none (install.sh's decision, the bundled copy, the launcher's order): `bash scripts/test-electron-bundle.sh`
- "Start with your desktop" (which sessions run autostart entries, the entry written / removed, nothing else touched): `bash scripts/test-autostart.sh`
- The app icon as Qt launchers draw it (no clip paths; transparent corners) and its hicolor PNGs installed: `bash scripts/test-app-icon.sh`
- Rules and docs: `bash scripts/check-rules.sh`
- The TODO / decisions merge driver (block-level, no conflict when branches touch different items): `bash scripts/test-merge-docs.sh`
- Dev stack (NOT hermetic — the owner's session): `bash scripts/dev.sh` / `bash scripts/dev-stop.sh`
- Agent window (NOT hermetic — its own headless compositor, sandboxed backend, Vite and CDP port; it never writes to the session's Hyprland; CDP scripts and benches drive it, never the owner's window): `bash scripts/agent-window.sh up|status|down`
- Live UI benchmark (NOT hermetic — drives the agent window; `--owner` the owner's): `node scripts/bench-live-ui.mjs <scenario>` — real frame times at the window's measured refresh rate
- Inspect a running player (read-only): `liascape ctl state|logs|probe` (skill `player-debug`)

## Hard rules
- Features compose: every feature keeps working alongside every other one it can co-occur with. Fix the interaction; never disable one behind another. Only a demonstrable hard limit excuses an incompatibility — say so explicitly. After building something, list the modes it touches and verify each combination (e.g. transitions × timed / advance-on-end / manual / random / restore × V→V, V→S, S→V, S→S).
- Settings apply live: a change takes effect on the playing wallpaper at once, at its effective value (`override ?? global`). Wire a new setting's live path too; no setting is launch-only.
- Tests are hermetic: own HOME / XDG dirs, backend, player socket and audio server. Never start, stop, restart or reconfigure the owner's running app, player, settings, library or keyring from a test or an experiment.
- Never print, log or commit secrets: never `cat` `~/.config/liascape/settings.json` or `~/.config/liascape/steam-auth.json`, the API token (`serve.token`), or keyring values. Steam tokens live in `src/backend/Helpers/SecretStore.cs` (keyring, else `steam-auth.json`), never in settings.json. The repo is public: no personal details of the owner (accounts, emails, IPs, hostnames) in code, docs or commits; one person's own machine, habits or workflow go in their gitignored `CLAUDE.local.md`.
- Every owner request or agreed decision becomes a `docs/TODO.md` item in the turn it is agreed, before work starts; a
  spec under `docs/superpowers/` stays named by an item until it is fully built (`.claude/rules/writing-rules.md`).
- Shared state files (settings, playlist state, library `index.json`) are written field-level and atomically: `.claude/rules/backend/state-files.md`.
- Before the first release no one else runs Liascape: CLI flags and state-file formats may change freely, with no compatibility code for old files. Keep them stable once it ships.
- Every new UI element follows the app's design and its toggles (theme, glow / `no-glow`, motion / `no-motion`, translucency / `bg-live`, themed controls, a probe): the checklist at the top of `.claude/rules/ui/design.md`. Put it in every UI agent's brief.
- Commit titles say what changed, in the imperative and Start Case (`Fix App Name`, `Hold A Restored Layer Until Ready`; names keep their own case: `mpv`, `liascape-player`), ≤72 characters, no period — never the process (`Fix PR 7 Review Findings` → name the fix). The body says why: what broke and how it showed, the cause, the guard test that pins it; wrap at 100. `scripts/git-hooks/commit-msg` checks the title and the trailer and strips `Claude-Session:` lines (once per clone: `bash scripts/setup-clone.sh`, which also sets the TODO / decisions merge driver).
- No Claude session links (`claude.ai/code/session_…`) in commits, PR descriptions, PR comments or issues: they open for no one but their owner. PR text has no hook; check it before posting.
- A commit Claude co-wrote carries one `Co-Authored-By: Claude <Model> <version>, effort <low|medium|high|xhigh|max|unknown> <noreply@anthropic.com>` line per model and effort (`Co-Authored-By: Claude Opus 5.5, effort medium <noreply@anthropic.com>`), and no other Claude line; the hook turns a `Claude-Agent: <model id>, effort <…>, <role>` line into it. The effort is what the agent's starter set; a session can't see its own, so it writes `unknown`. A subagent reports its model and effort so the committer can name it.
- A change to something `README.md` already says (install, a command, a feature, a setting it names) updates it in the same commit; it never lists every change (`.claude/rules/writing-rules.md` § README.md).
- Code comments say why, never history — no dates, owner quotes or R/Phase/Task numbers: `.claude/rules/writing-rules.md` § Code comments.

## Where the rule for X lives
Path-scoped rules load when you read or edit matching files; open one directly when your task touches its area.

| area | rule file |
|---|---|
| writing rules, docs, skills | `.claude/rules/writing-rules.md` |
| writing, changing or fixing tests, probes, a red test result | `.claude/rules/testing.md` |
| build, install, flake, PKGBUILD, AppImage, launcher, dev stack | `.claude/rules/build-and-packaging.md` |
| backend web API, security, WS events, feature health | `.claude/rules/backend/api.md` |
| settings, sessions, atomic state files | `.claude/rules/backend/state-files.md` |
| library, index, loudness, scene properties, trash | `.claude/rules/backend/library.md` |
| scrapers, Workshop, Steam sign-in, secrets, downloads | `.claude/rules/backend/sources-steam.md` |
| C# side of liascape-player; rotation semantics | `.claude/rules/backend/player-adapter.md` |
| Rust player: core invariants, graph, clocks, snapshot, supervisor | `.claude/rules/player/core.md` |
| Rust player: EGL, Wayland, composition | `.claude/rules/player/gfx-wayland.md` |
| Rust player: sources, mpv, audio bus | `.claude/rules/player/sources-audio.md` |
| Rust player: transitions, programs, signals, runtime, command API | `.claude/rules/player/runtime-api.md` |
| Rust player: scenes, scene worker, LWE core | `.claude/rules/player/scenes.md` |
| UI look, motion, controls, performance | `.claude/rules/ui/design.md` |
| UI store and backend API use | `.claude/rules/ui/state-and-api.md` |
| Electron shell, probes, UI matrix | `.claude/rules/ui/shell-and-probes.md` |

## Reference docs (read on demand)
- `docs/player/architecture.md` (the player's design), `docs/player/invariants.md`, `docs/player/debugging.md`, `docs/player/modules/` (how each player module works now: one file per module, `scene-*.md` for the scene worker, `persistence.md` for snapshot/outbox/supervisor), `docs/player/adapter.md` (the C# adapter's walkthrough).
- `docs/decisions.md` — why things are the way they are: the choices that ruled out a tempting alternative (read before "fixing" one back).
- Status and to-do: `docs/TODO.md` (a done item is deleted in the commit that does it). Work agreed but not started goes in its "Queued" section, in order, the moment it's agreed; the next task comes from the top of it.
