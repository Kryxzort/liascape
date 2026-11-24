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
- `install.sh` preflights every toolchain before any side effect and hard-fails without liascape-player's (it plays every wallpaper: never a build without it). `--no-scenes` is the only optional part.
- Internal executables go in `<prefix>/libexec/liascape/` (`LIBEXECDIR`; the PKGBUILD's is `/usr/lib`, so `/usr/lib/liascape/`: Arch's guidelines rule out `/usr/libexec`), never on `PATH`; only `bin/liascape` is user-facing. The launcher and the backend look in both.
- The launcher resolves everything from its own real path (`readlink -f`) and lets an already-set `LIASCAPE_*` win; keep it relocatable (install.sh, AppImage and the flake share it).
- CLI commands and flags (`liascape help` lists them; `Program.cs` parses them) may change freely before the first release (`CLAUDE.md` § Hard rules).

## Electron
- Use the system's Electron (`electron45`, else `electron` on PATH; the PKGBUILD's `electron45` depend, the flake's `electron` binding, also the devShell's `LIASCAPE_ELECTRON`; the AppImage bundles the npm one). One supported major everywhere: the flake's `electron_45`, `app/shell/package.json` + its lockfile with the exact-version `allowScripts` entry, the launcher's and PKGBUILD's `electron45` name, and the AppImage move together; nixpkgs fails to evaluate an EOL major (insecure), so move rather than allow it. Never below 42 — older Chromium crash-loops the GPU process on NVIDIA with kernel ≥ 6.12.
- The shell's Chromium profile is `~/.config/liascape-shell`, apart from the backend's `~/.config/liascape`.

## Nix
- `liascape-player` is wrapped with `--prefix LD_LIBRARY_PATH : /run/opengl-driver/lib` (libmpv's nvdec needs NVIDIA's `libcuda.so.1`, outside the store).
- Run cargo through the devShell without the shell's stray `LD_LIBRARY_PATH`: `env -u LD_LIBRARY_PATH nix develop -c …` (`scripts/lwe.sh --nix` does this).
- Don't run a blind `nix flake update`: diff the lock and build first.

## LWE core (scenes)
- Built from the owner's fork at the commit in `third_party/lwe/PIN`, with `patches/lwe/` on top, by `scripts/lwe.sh fetch prepare build check`. Patch and upstream policy: `UPSTREAM.md`.
- A cargo build that bakes a Nix store core into the worker's RUNPATH (the devShell's `LIASCAPE_LWE_CORE_DIR`, no `LIASCAPE_LWE_RPATH`) roots it: `build.rs` `root_core` points the indirect GC root `<target>/<profile>/lwe-core-gcroot` at it and re-points it when the core changes (a new pin), so a garbage collection never takes a built worker's core (every worker would exit 127) and an old core goes once no build dir names it. Guard: `src/player/tests/lwe_build.rs::worker_build_roots_its_core`.

## Dev stack
- `bash scripts/dev.sh` installs and starts the systemd user units `liascape-vite` (HMR :5173) and `liascape-watch` (`dotnet watch … serve`, :5174, media :5175) from `scripts/dev/`; `bash scripts/dev-stop.sh` stops them. Launch the app normally; `app/shell/main.js` detects Liascape's Vite by its marker header (`app/shell/vite-detect.js`).
- The dev backend keeps `serve.token` across `dotnet watch` restarts; Vite's dev-only `/__liascape/token` (`app/ui/vite.config.ts`) hands it to a page opened without `?token=`. A browser tab without Electron: `http://localhost:5173/?api=5174&token=$(cat ~/.config/liascape/serve.token)`.

## Binary resolution (backend)
- `PlayerStatus.ResolveBinary`: `LIASCAPE_PLAYER_BIN` → next to `liascape-backend` → `<prefix>/libexec/liascape/` → `<prefix>/lib/liascape/` → the repo's release build, then its debug build → `PATH`. A missing player is an error with its reason (`/player-engine` `available:false`, `/apply` refuses with it), never a fallback; it never crashes. Guard: `scripts/test-player-binary.sh`.
