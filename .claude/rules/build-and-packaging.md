---
paths:
  - "scripts/liascape"
  - "scripts/install.sh"
  - "scripts/PKGBUILD"
  - "scripts/build-appimage.sh"
  - "scripts/lwe.sh"
  - "scripts/dev.sh"
  - "scripts/dev-stop.sh"
  - "scripts/dev/**"
  - "flake.nix"
  - "flake.lock"
  - ".envrc"
  - "deps.json"
  - "third_party/lwe/**"
  - "app/shell/package.json"
  - "src/backend/liascape-backend.csproj"
  - "src/player/Cargo.toml"
---

# Build, packaging and the launcher

The install layout and every build knob are documented in the header of `scripts/install.sh` (read it); the launcher
is `scripts/liascape` (why a shell script: `docs/decisions.md` § Build & distribution).

## One build, one layout
- `scripts/install.sh` is the only imperative build: `PKGBUILD` and `scripts/build-appimage.sh` run it (`DESTDIR=… PREFIX=/usr`). Add a new file, dependency or helper there, not in a package script. The flake is the one exception: it builds the same layout declaratively — change both.
- `install.sh` preflights every toolchain before any side effect and hard-fails without the native helpers' toolchain (transitions are a core feature, never a silent no-op). `--no-scenes` is the only optional part.
- Internal executables go in `<prefix>/libexec/liascape/`, never on `PATH`; only `bin/liascape` is user-facing.
- The launcher resolves everything from its own real path (`readlink -f`) and lets an already-set `LIASCAPE_*` win; keep it relocatable (install.sh, AppImage and the flake share it).
- CLI commands and flags (`liascape help` lists them; `Program.cs` parses them) may change freely before the first release (`CLAUDE.md` § Hard rules).

## Electron
- Use the system's Electron (`electron` on PATH, AUR `depends`, the flake's `electron_42`; the AppImage bundles one). Keep the 42.x pin in `app/shell/package.json` with its exact-version `allowScripts` entry — older Chromium crash-loops the GPU process on NVIDIA with kernel ≥ 6.12.
- The shell's Chromium profile is `~/.config/liascape-shell`, apart from the backend's `~/.config/liascape`.

## Nix
- `liascape-player` is wrapped with `--prefix LD_LIBRARY_PATH : /run/opengl-driver/lib` (libmpv's nvdec needs NVIDIA's `libcuda.so.1`, outside the store).
- Run cargo through the devShell without the shell's stray `LD_LIBRARY_PATH`: `env -u LD_LIBRARY_PATH nix develop -c …` (`scripts/lwe.sh --nix` does this).
- Don't run a blind `nix flake update`: diff the lock and build first.

## LWE core (scenes)
- Built from the owner's fork at the commit in `third_party/lwe/PIN`, with `patches/lwe/` on top, by `scripts/lwe.sh fetch prepare build check`. Patch and upstream policy: `UPSTREAM.md`.

## Dev stack
- `bash scripts/dev.sh` installs and starts the systemd user units `liascape-vite` (HMR :5173) and `liascape-watch` (`dotnet watch … serve`, :5174, media :5175) from `scripts/dev/`; `bash scripts/dev-stop.sh` stops them. Launch the app normally; `app/shell/main.js` detects Vite.
- The dev backend keeps `serve.token` across `dotnet watch` restarts; Vite's dev-only `/__liascape/token` (`app/ui/vite.config.ts`) hands it to a page opened without `?token=`. A browser tab without Electron: `http://localhost:5173/?api=5174&token=$(cat ~/.config/liascape/serve.token)`.

## Binary resolution (backend)
- `PlayerEngine.ResolveBinary`: `LIASCAPE_PLAYER_BIN` → next to `liascape-backend` → `<prefix>/libexec/liascape/` → the repo's release build, then its debug build → `PATH`. A missing player falls back to legacy with `/player-engine` `available:false`; it never crashes.
