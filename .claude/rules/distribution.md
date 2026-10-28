## Distribution

Users type **one command, `liascape`** (git/cargo style): bare = the app, `liascape <command>` = the CLI
(`liascape help`), `liascape ctl …` = the player's control socket. It is a launcher script,
**`scripts/liascape`**, installed as `<prefix>/bin/liascape` by every package; it resolves everything relative to
its own real path (`readlink -f`), exports `LIASCAPE_UI_DIR` / `LIASCAPE_TRANSITIONS_DIR` / `LIASCAPE_BACKEND` and the
`LIASCAPE_{PLAYER,SCENE_WORKER,TRANSITION,AUDIO}_BIN` of the helpers that are present (any already-set
`LIASCAPE_*` wins), then execs Electron (`$LIASCAPE_ELECTRON`, else `electron` on PATH) on `lib/liascape/shell`,
the player's `ctl`, or `liascape-backend "$@"`. Why a shell launcher and not the C# binary: the GUI and `ctl` need
neither .NET's startup nor its runtime, and one relocatable script serves install.sh, the AppImage and the flake.

**The layout (all packages):**

| path | what |
|---|---|
| `bin/liascape` | the launcher (`scripts/liascape`) |
| `libexec/liascape/liascape-backend` | the C# backend (`src/backend/`, `liascape-backend.csproj`): `serve`, the CLI, the daemons. install.sh: a symlink to `../../lib/liascape/backend/liascape-backend` (the self-contained apphost finds its runtime from its real path) |
| `libexec/liascape/liascape-player`, `liascape-scene-worker` | the Rust compositor + its per-scene worker (`src/player/`) |
| `libexec/liascape/liascape-transition`, `liascape-audio` | the legacy engine's C helpers (`src/native/<name>/`, auto-discovered) |
| `lib/liascape/{backend,ui,shell,transitions}` | the published backend, the React UI, the Electron shell (its JS only), the effect catalogue |
| `lib/liascape/liblinux-wallpaperengine-core.so*` | LWE's core (scenes); the worker's RUNPATH is `$ORIGIN/../../lib/liascape` |
| `share/applications/liascape.desktop` | `Exec=<prefix>/bin/liascape`, `StartupWMClass=liascape` |

The Electron shell: `app/shell/package.json` `productName` **Liascape**, `desktopName` `liascape.desktop` (the
Wayland app id `liascape`), window title "Liascape"; Chromium's profile is pinned to `~/.config/liascape-shell`
(`main.js` `app.setPath("userData", …)`), away from the backend's `~/.config/liascape`.

### `scripts/install.sh` — the one build
Preflights (Rust toolchain first, then the native toolchain + dev headers, then LWE's build deps unless
`--no-scenes`) before any side effect; then builds the UI (`npm run build`), publishes the backend
(`dotnet publish src/backend -r linux-x64 --self-contained`), stages the UI / shell / transitions, builds every
`src/native/*` helper, builds LWE's core (`scripts/lwe.sh`) and `cargo build --release --locked` the player
(`LIASCAPE_LWE_RPATH='$ORIGIN/../../lib/liascape'`), installs the launcher and the desktop entry. Knobs: `PREFIX`
(default `~/.local`; packages `/usr`), `DESTDIR` (staging root). `--dry-run` prints the layout, `--help` the header.
The `PKGBUILD` (`liascape-git`) and `scripts/build-appimage.sh` both run it (`DESTDIR=… PREFIX=/usr`); the AppImage's
`AppRun` only sets `LIASCAPE_ELECTRON` to its bundled electron and execs `usr/bin/liascape`.

**Electron** is the system's (`electron` on PATH; AUR `depends=(electron)`; the flake uses nixpkgs' `electron_42`;
the AppImage bundles `app/shell/node_modules/electron`). Keep the 42.x pin (`app/shell/package.json`, with its
`allowScripts` entry keyed to the exact version) — older Chromium crash-loops the GPU process on NVIDIA + kernel ≥6.12
(memory `freeze-diagnostics`).

### `flake.nix`
Packages `ui`, `backend` (`buildDotnetModule`, `executables = [ "liascape-backend" ]`), `liascape-transition`,
`liascape-audio`, `lwe-core`, `liascape-player` and **`liascape`** (= `default`, `apps.default`): the same layout —
`lib/liascape/{ui,shell}` symlinked to the `ui` / shell-source derivations, `transitions` copied, `libexec/liascape/*`
symlinked to the component packages' binaries, `bin/liascape` = `scripts/liascape` (`patchShebangs` +
`wrapProgram --set-default LIASCAPE_ELECTRON ${electron_42}/bin/electron --prefix PATH : <ffmpeg, mpvpaper,
linux-wallpaperengine, mpv>`; the launcher's `readlink -f` lands on `.liascape-wrapped` in the same `bin/`).
`liascape-player` gets `wrapProgram … --prefix LD_LIBRARY_PATH : /run/opengl-driver/lib --suffix PATH : ffmpeg` (R86:
libmpv's nvdec needs NVIDIA's `libcuda.so.1`, which on NixOS lives outside the store); its scene worker sits next to
it in the same `bin/` (`paths::scene_worker_bin` finds it by `/proc/self/exe`). The devShell (`inputsFrom` the
component derivations + dotnet/node/cargo/sccache) sets `LIASCAPE_LWE_CORE_DIR`. NixOS installs it with
`environment.systemPackages = [ (builtins.getFlake "github:Kryxzort/liascape/<rev>").packages.${system}.default ]`.

**Binary resolution in the backend** (`PlayerEngine.ResolveBinary`): `LIASCAPE_PLAYER_BIN` (the launcher sets it) →
next to `liascape-backend` → `<prefix>/libexec/liascape/` (from `lib/liascape/backend/`) → the repo dev tree
`src/player/target/{release,debug}/liascape-player` → `PATH`. The transitions catalogue: `LIASCAPE_TRANSITIONS_DIR` →
`~/.local/lib/liascape/transitions` (the default install) → the repo's `transitions/`. A missing player never crashes:
`IsLiascapePlayer` is false, legacy keeps working, `/player-engine` reports `available:false` + the reason.

### Dev (no install)
`scripts/dev.sh` builds the native helpers + the player, (re)installs the systemd user units from their in-tree
definitions **`scripts/dev/liascape-vite.service`** (HMR :5173) and **`scripts/dev/liascape-watch.service`**
(`dotnet watch --no-hot-reload --project src/backend -- serve`, `LIASCAPE_PORT=5174`) with `@ROOT@` = the checkout's
physical path, and enables them. Launch the app normally; `main.js` auto-detects Vite. `scripts/dev-stop.sh` stops
them. `scripts/freeze-monitor.sh` watches for the main-thread freeze.

### Runtime deps
libmpv, Wayland + EGL/GLES, `libxkbcommon`, PipeWire (the player's audio bus), `ffmpeg` (thumbnails, frame grabs),
`wl-clipboard`; legacy engine: `mpvpaper`, `libpulse` (`liascape-audio`), `linux-wallpaperengine` for scenes.
