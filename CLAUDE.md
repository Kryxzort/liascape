# CLAUDE.md

**liascape** — Linux live-wallpaper manager for Wayland. An **Electron + React** UI over a **headless C# backend**: the same `liascape` binary runs the CLI, the background daemons, and a loopback web API (`--serve`) that the UI talks to. Wallpapers are applied via [mpvpaper](https://github.com/GhostNaN/mpvpaper) (videos) and [linux-wallpaperengine](https://github.com/Almamu/linux-wallpaperengine) (WE scenes).

## System Dependencies

- `mpvpaper`, `mpv` — video wallpaper player
- `.NET 10 SDK` — build the backend; `Node.js` / `npm` — build the React UI + run the Electron shell
- Wayland compositor (Hyprland, Sway, GNOME on Wayland)
- `pactl` / `parec` (libpulse) — Auto-Mute stream detection (+ live LWE scene volume via `pactl`)
- `ffmpeg` — thumbnail extraction (Import) + frozen-frame grabs + transition frame capture (→ raw RGBA)
- `wl-clipboard` — `wl-copy` for keybind Copy buttons (renderer uses `navigator.clipboard`, falls back to `wl-copy`)
- `linux-wallpaperengine` *(optional)* — WE **scene** support under the legacy engine (Settings → "Allow scene support"). Under `liascape-player` scenes need no installed binary — only Wallpaper Engine's own `assets/` (its Steam install, auto-found in the Steam libraries; else `LIASCAPE_WE_ASSETS_DIR` / `player.scene_assets`)
- *(build-time, REQUIRED)* Rust toolchain (`cargo`/`rustc`, edition 2024) + `libclang` (bindgen) + wayland/EGL/GLES/`mpv`/`libpipewire`/`libxkbcommon` dev — build `liascape-player` and its `liascape-scene-worker` (`install.sh` preflights them; the flake handles it)
- *(build-time, required unless `install.sh --no-scenes`)* `cmake` + `git` + SDL2/freetype/glm/lz4/zlib/FFmpeg/libGL dev — build LWE's `next-v2` core from the owner's fork (`third_party/lwe/PIN`, `scripts/lwe.sh`, `UPSTREAM.md`) for liascape-player's scene worker (`liascape-scene-worker` links it); `install.sh --no-scenes` skips it (scenes then hidden under liascape-player); the flake + devShell build it themselves
- `grim` — *fallback* scene-frame capture for transitions (scene-A cover); the primary path is LWE's own `--screenshot` (windowless framebuffer dump per output)
- *(build-time, REQUIRED)* `cc` + `make` + `wayland-scanner` + wayland/EGL/GLES + `mpv` dev headers — build `liascape-transition` (transition renderer). Transitions animate every wallpaper switch and are a core feature, never a no-op — `install.sh` hard-fails if the toolchain is missing (the flake handles it automatically)
- *(build-time, REQUIRED)* `cc` + `libpulse` dev — build `liascape-audio` (event-driven scene-audio crossfade helper) so scene switches crossfade instead of hard-cutting audio

## Common Commands

```bash
bash scripts/dev.sh                              # dev: Vite HMR (:5173) + dotnet watch --serve (:5174) as systemd user units
liascape                                        # open the app (GUI) — bare command launches the Electron shell
liascape-ui                                     # explicit GUI launcher (Electron)
dotnet run --project src/backend -- --serve    # backend only (headless loopback API)
cd app/ui && npm run dev                          # React UI only, in a browser (append ?api=<backend-port>)
dotnet build src/backend                        # build backend (no solution file at root)
cd app/ui && npm run build                        # build the UI bundle (dist/)
bash scripts/install.sh                           # build UI + publish backend, install liascape + liascape-ui
electron app/shell/probe.js http://127.0.0.1:<port>   # headless UI self-test (offscreen, counts rendered elements)
```

> **Note:** `app/shell` has its own Electron (decoupled from `demos/`, which is the old framework bake-off — kept, untracked). The CDP debug window (`LIASCAPE_DEBUG=1`, port `:9222`, `node app/shell/cdp.js "<expr>"`) is for read-only inspection.

## CLI Flags

`liascape` with **no args opens the GUI**; any flag runs headless:

- `--serve` *(internal default for the backend)* — headless web API on `127.0.0.1:<random>`, port written to `~/.config/liascape/serve.port`. The Electron shell spawns this with an explicit `--serve`.
- `--restore` — re-applies last session without a UI. Timed playlists: `setsid`-spawns `--timer-daemon` and returns.
- `--random` — picks a random library wallpaper, applies, exits. Saves the pick so `--restore` replays it.
- `--kill` — stops playback, exits.
- `--monitor` *(internal)* — starts `AudioMonitor`, blocks. Spawned detached when the app closes with AutoMute on.
- `--timer-daemon` *(internal)* — owns the timed-playlist tick loop, blocks. Spawned by `--restore` (timed) and on close.
- `--restart-daemon` *(internal)* — periodically relaunches mpvpaper (frame-buffer leak workaround). Blocks. Spawned by `--restore`/on-close when playing; killed by `--kill` and on app open.
- `--action=<action>` — sends a command to the running session, exits:
  - `toggle-mute`, `toggle-pause`, `stop`, `play`, `toggle-play`
  - `next-wallpaper`, `previous-wallpaper`, `random`
  - `volume-up` / `volume-down` — ±5, clamped 0–100, persisted to settings.json

## Architecture

```text
src/backend/            # headless C# backend (CLI + daemons + --serve API). NO GUI here anymore.
├── Models/               # WallpaperResult, WallpaperDetail, LibraryItem, AppSettings, LastSession, LibMeta
├── Scrapers/             # MotionBgsScraper, MoewallsScraper, DesktophutScraper, WallpaperEngineScraper (static HTTP+HTML)
├── Services/             # IBgsProvider + one service per source; SteamWorkshopService
├── Helpers/              # PlayerHelper, DownloadHelper, LibraryService, LibraryStore, ImportService,
│                         #   SettingsService, AudioMonitor, MonitorDetector, TransitionService, WorkshopDownloader, WorkshopUnsubQueue,
│                         #   SceneProperties (a WE scene's project.json user properties — library.md)
├── Player/               # liascape-player adapter (PlayerEngine=liascape-player) — .claude/rules/player-adapter.md
└── Web/                  # ServerHost (minimal-API endpoints), AppOps (orchestration), EventBus (WS), SteamOps
src/native/liascape-transition/ # C: wlr-layer-shell + EGL/GLES transition renderer (built by install.sh) — legacy engine
src/native/liascape-audio/      # C: libpulse helper — event-driven scene-audio crossfade (built by install.sh) — legacy engine
src/player/               # Rust: liascape-player, the experimental compositor replacing mpvpaper + liascape-transition +
                          #   per-monitor LWE + liascape-audio with one process; also builds `liascape-scene-worker`, the
                          #   per-scene LWE worker process. docs/player/architecture.md, .claude/rules/player-core.md
patches/lwe/, third_party/lwe/  # our LWE `next-v2` patch series + its pin (build-time fetch, scripts/lwe.sh, UPSTREAM.md)
transitions/             # shared GLSL effect catalog (glsl/ + manifest.json + wrap.* + preview/) — UI previews +
                          #   the legacy renderer + liascape-player's effect catalogue (credited in UPSTREAM.md)
docs/player/              # AI-facing liascape-player docs: architecture.md, invariants.md, spikes/
app/
├── ui/                   # Vite + React 19 + TS + zustand + framer-motion (the renderer)
└── shell/                # Electron main/preload + probes; spawns `liascape --serve`, loads the UI same-origin
```

WE-style **transitions** animate every wallpaper switch (gl-transitions GLSL) — see `.claude/rules/player.md`. v1: video→video, **full-live** (both sides keep playing through the effect — libmpv decodes A+B in the renderer; frozen stills are the warmup/scene fallback).

The Avalonia UI (`Views/`, `ViewModels/`, `App.axaml`) was **removed** in the Electron rewrite — don't reference it. `Web/` only wraps the unchanged scrapers/helpers/daemons; UI lives in `app/`. See `.claude/rules/web-backend.md` + `web-ui.md`.

**Player engine.** `AppSettings.PlayerEngine` = `legacy` (default: mpvpaper + `liascape-transition` + per-monitor LWE +
`liascape-audio`, described above) | `liascape-player` (experimental: one Rust process owning every wallpaper type and
transition, built so it never hands an audible/visible stream between owners — video/image/colour, and WE
scenes (Phase 2, done bar its on-machine battery: an `liascape-scene-worker` process per scene source, dmabuf frames,
its own audio stream on the player bus, crash isolation) when its worker + WE's assets resolve, else scenes are
skipped like `AllowScenes=false`). Scenes play under it with every transition method; `LweMonitors` fps, the GPU
budget / VRAM settings, scene user properties, speed and volume are all live there. Switch is live (Settings → Advanced → "Player engine").
Dev: `cd src/player && env -u LD_LIBRARY_PATH nix develop -c cargo test -q` (the stray `LD_LIBRARY_PATH` this
machine's shell carries breaks native links — see `.claude/rules/player-core.md` for why); `liascape-player ctl state` /
`ctl logs '{"corr":"..."}'` / `ctl probe '{"name":"sources"}'` inspect a running player. Full design, the block
model and a debug-mode quickstart: `docs/player/architecture.md`. Per-module detail: `.claude/rules/player-core.md`
(the Rust crate) and `.claude/rules/player-adapter.md` (the C# side). What's done vs pending: `docs/TODO.md` → "liascape-player".

## Engineering Rules

- **Features must compose.** Any feature must keep working alongside *every other* feature/mode it can co-occur with — fix the interaction, never ship a broken combo or "park"/disable one behind another. Only a demonstrable hard limit (physical/architectural) excuses an incompatibility, and then say so explicitly. After building something, enumerate the modes it touches and verify each combo. (Transitions, for example, must work across: pure-timed, advance-on-video-end (with a minimum / maximum play time), manual next/prev, random, restore — all four switch combos V→V/V→S/S→V/S→S.)
- **Settings apply live.** A settings/override change must take effect on the *currently-playing* wallpaper immediately — never require a stop / replay / relaunch to see it. Videos: mpv IPC (`SendCommand`/`set_property`) — `PlayerHelper.ApplyPlaybackSettingsLive` diffs prev→cur and pushes `Loop`/`NoAudio` (`aid` — `aid auto` re-inits the ao even after a `--no-audio` launch)/`VideoFps` (`vf`)/`DisableCache` (`cache`)/`Demuxer*`/`HwDec` live; Volume/Speed/VideoScale/Normalization/AutoMute wired separately in `/settings`. Scenes: `pactl` / `liascape-audio` — Volume + `NoAudio` (mute) toggle live (scenes launch with the audio device OPEN — primary at `--volume 0` when NoAudio, **never `--silent`** — so mute is reversible; the live toggle holds via liascape-audio to beat LWE's stream re-creation). Rotation ("Switch when video ends" off → the interval is a plain timer; on → the same field is the minimum play time + `MaxPlaySeconds` the maximum, and "Separate timing for scenes" gives scenes + still images their own "Switch scenes after"; every limit 0 = off — `player-adapter.md` § Rotation) live-updates a RUNNING timed playlist via `UpdateTimedSettings` (`ApplyRotationLive`) / `ApplyPlayLimitsLive` from `/settings` (global, when the session follows globals) + `/playlist/state` (per-playlist override, diffed vs prev so a reorder/add never resets the countdown or the item's play time; a new minimum re-arms an armed end-of-video switch). The `/settings` endpoint applies the *effective* (`override ?? global`) value so a global change never clobbers an active per-item override; `/library/volume|speed` save the override then `ApplyOverrideLive` retargets the live wallpaper, and `/preview` is the no-persist drag twin. When adding a setting, wire its live path too (or note explicitly why it's launch-only — the only genuine ones are under legacy, which LWE can't reconfigure without a relaunch: `LweMonitors` per-monitor fps/primary and a scene's user properties (`--set-property`) — under liascape-player both are live, `out:<name>.scene_fps` / `scene_props`).

## Commit Style

Short, title-case, no period. e.g. `Fix App Name`, `Add Shuffle Toggle`.
