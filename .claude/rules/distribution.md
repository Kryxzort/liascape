---
paths:
  - "scripts/**"
  - "app/shell/package.json"
  - "app/ui/package.json"
---

## Distribution

The app ships as **two pieces**: a published self-contained C# backend + the built React UI, launched by an Electron shell.

### `scripts/install.sh` — the current installer
1. `cd app/ui && npm install && npm run build` → UI bundle in `app/ui/dist/`.
2. `dotnet publish src/backend -r linux-x64 --self-contained` → backend in `~/.local/share/liascape-web/backend`.
3. Stages the UI to `~/.local/share/liascape-web/ui`; ensures `app/shell`'s Electron (`npm install`).
4. Installs to `~/.local/bin`:
   - **`liascape`** — bare = open the GUI (`exec liascape-ui`); any flag = the headless backend/CLI (`backend/liascape "$@"`). Sets `LIASCAPE_UI_DIR`.
   - **`liascape-ui`** — runs Electron on `app/shell` (sets `LIASCAPE_BACKEND` + `LIASCAPE_UI_DIR`).
5. Writes `~/.local/share/applications/liascape.desktop` (Exec=`liascape-ui`).

**Electron is `app/shell/node_modules/electron`** (version pinned in `app/shell/package.json`, currently **42.5.0** — older Electron's Chromium crash-loops the GPU process on NVIDIA + kernel ≥6.12, see `freeze-diagnostics`). `app/shell/package.json` has an `allowScripts` allowlist keyed to the exact version so Electron's binary-download postinstall runs (bump it when bumping Electron). `install.sh` aborts if the binary is missing — no `demos/` fallback (`demos/` is gitignored/local-only, absent on a clone).

### ⚠️ Stale / not-yet-rebuilt packaging
- **`scripts/build-appimage.sh`** and **`scripts/PKGBUILD`** still build the **pre-rewrite single-binary Avalonia app** (PKGBUILD has no `nodejs`/`electron` deps and points at the old upstream repo). They do **not** produce the current Electron+backend stack — treat as broken until rewritten.
- **AppImage via electron-builder is NOT set up** — `app/shell/package.json` has only a `start` script (no `build`/`dist`, no electron-builder config). The "`npm run dist`" mentioned in older notes/README does not exist yet.
- The old `src/backend/Assets/` icon (`liascape.svg`/`.png`) was **deleted**; there is no packaged app icon wired up yet (the `.desktop` entry sets no `Icon=`). UI/static assets live under `app/ui/public`.

### Dev (no install)
`scripts/dev.sh` → systemd user units: `liascape-vite` (HMR :5173) + `liascape-watch` (`dotnet watch -- --serve` :5174). Launch the app normally; `main.js` auto-detects Vite. `scripts/dev-stop.sh` stops them. `scripts/freeze-monitor.sh` watches for the main-thread freeze.

### `liascape-player` (Rust compositor, `src/player/`) — Task 18

**`scripts/install.sh`**: a Rust toolchain (`cargo`/`rustc`) preflight runs **first, before any other
build/publish step** (hard fail with a per-distro install hint, same style as the existing
cc/make/pkg-config check below it — Arch/Debian/Fedora/NixOS) — a missing toolchain must not burn
minutes of npm/dotnet work before failing. Then `cargo build --release --locked --manifest-path
src/player/Cargo.toml` and `install -Dm755 … ~/.local/share/liascape-web/bin/liascape-player` — a **fixed**
location independent of `$PREFIX`/`$DESTDIR` (same convention `TransitionService.cs`'s hardcoded
candidate dir and `Catalogue::resolve_dir` already use for assets installed outside the main
`$PREFIX/lib/liascape` tree). Both wrappers `install.sh` writes (`liascape`, `liascape-ui`) export
`LIASCAPE_PLAYER_BIN` to that path (guarded by `[ -x … ]`, matching the existing `LIASCAPE_TRANSITION_BIN`/
`LIASCAPE_AUDIO_BIN` style).

**`flake.nix`**: the `liascape-player` package (`pkgs.rustPlatform.buildRustPackage`, Task 3) gets a
`postInstall` `wrapProgram $out/bin/liascape-player --prefix LD_LIBRARY_PATH : /run/opengl-driver/lib` (R86)
— libmpv's nvdec hwdec needs the NVIDIA proprietary driver's `libcuda.so.1`, which on NixOS lives
outside the Nix store at the impure `/run/opengl-driver/lib` mount (`hardware.nvidia` provides it);
`--prefix` (not `--set`) extends rather than replaces a caller's own `LD_LIBRARY_PATH`, and is a no-op
on non-NVIDIA machines (the path just doesn't exist). The `liascape-ui` and `liascape-cli` wrappers
in the top-level `liascape` derivation both get `--set LIASCAPE_PLAYER_BIN ${liascape-player}/bin/liascape-player`
alongside their existing `LIASCAPE_TRANSITION_BIN`/`LIASCAPE_AUDIO_BIN` sets.

**Binary resolution** (`PlayerEngine.ResolveBinary`, `src/backend/Player/PlayerEngine.cs`): env
`LIASCAPE_PLAYER_BIN` → next to the running `liascape` executable → the repo dev tree
`src/player/target/{release,debug}/liascape-player` (walking up from the assembly) → `PATH`. Both packaging
paths above work by setting `LIASCAPE_PLAYER_BIN` directly, so the backend never has to search
`~/.local/share/liascape-web/bin` itself — that directory is a fixed drop location, not one more
entry in `ResolveBinary`'s own search order. A missing binary never crashes: `IsLiascapePlayer` reports false,
legacy keeps working, and `/player-engine` reports `available:false` + the reason.

**Runtime deps** (`.claude/rules/player-core.md` § Sources / § Audio bus): libmpv (`mpv`/
`mpv-unwrapped` — the same library `liascape-transition` already links), Wayland + EGL/GLES (`wayland`,
`libGL`), `libxkbcommon` (seat/keyboard via smithay-client-toolkit), and PipeWire (`pipewire`, the
player's own audio bus — replaces `liascape-audio` under `PlayerEngine=liascape-player`). The flake's `liascape-player`
derivation already carries all of these as `buildInputs` (Task 3) plus `rustPlatform.bindgenHook` +
`pkg-config` for the libmpv FFI bindgen; `install.sh` relies on the existing cc/make/pkg-config
preflight's `mpv` check for the same header `bindgen` needs, and on the system having a Rust toolchain
new enough for edition 2024 — it does not independently re-verify wayland/EGL/libxkbcommon/pipewire
dev packages, so a `cargo build` failure over one of those reports cargo's own (clear) linker/pkg-config
error rather than a custom hint.
