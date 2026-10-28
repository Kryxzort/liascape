# liascape

A live wallpaper manager for Wayland. Browse and download animated wallpapers from online sources, or play wallpapers directly from your local Wallpaper Engine library — all applied to your desktop using [mpvpaper](https://github.com/GhostNaN/mpvpaper) (and [linux-wallpaperengine](https://github.com/Almamu/linux-wallpaperengine) for scenes).

The interface is an **Electron + React** app over a **headless C# backend** — the same `liascape` binary runs the CLI, the background daemons, and a local web API that the UI talks to.

![liascape](docs/app.png)

## Requirements

- Wayland compositor (Hyprland, Sway, GNOME on Wayland, etc.)
- [mpvpaper](https://github.com/GhostNaN/mpvpaper)
- `ffmpeg` (auto-generates thumbnails when importing videos)
- `libpulse` (provides `pactl`/`parec` for Auto-Mute; satisfied by either `pulseaudio` or `pipewire-pulse` on Arch)
- `wl-clipboard` (`wl-copy` keeps Settings-tab snippets on the clipboard after liascape closes)
- .NET 10 SDK **and** Node.js / npm (for building from source — the C# backend and the React UI respectively)
- **Native build toolchain** (required — transitions and scene-audio crossfade are core features): `cc`, `make`, `wayland-scanner`, `pkg-config`, and dev headers for `wayland`, `egl`, `glesv2`, `mpv`, `libpulse`. `install.sh` hard-fails with a per-distro fix if any are missing. *(On NixOS the flake below handles all of this — no manual install.)*

### Optional

- `playerctl` — required for the "Only mute if MPRIS media player is active" Auto-Mute option; without it the option has no effect
- [linux-wallpaperengine](https://github.com/Almamu/linux-wallpaperengine) — required for Wallpaper Engine **scene** support (enable in Settings → Sources → "Allow scene support")

## Installation

### AUR

```bash
yay -S liascape-git
```

> ⚠️ Not published to the AUR yet — `scripts/PKGBUILD` builds through `scripts/install.sh` (`makepkg` in `scripts/`); until it is, install from source.

### From source

```bash
git clone https://github.com/Kryxzort/liascape.git
cd liascape
bash scripts/install.sh            # add --no-scenes to build without Wallpaper Engine scene support under liascape-player
```

Builds the React UI, publishes the self-contained C# backend, builds the player, and installs **`liascape`** to `~/.local/bin` (bare = open the app; `liascape <command>` = the CLI) and a desktop entry. Its internal programs go to `~/.local/libexec/liascape/` (off `PATH`), the UI, the Electron shell and the effect catalogue to `~/.local/lib/liascape/` — `bash scripts/install.sh --dry-run` prints the layout.

> The install script assumes its runtime deps (`ffmpeg`, `mpvpaper`, Electron, …) resolve from your system in the usual FHS paths — true on Arch/Ubuntu/Fedora. **NixOS has no global lib paths**, so use the flake below instead; it carries every dependency with it.

### Build dependencies

What `scripts/install.sh` needs on your machine to build everything (the experimental `liascape-player` engine and its
Wallpaper Engine scene worker included). It checks each group **before** building anything and hard-fails with the
matching package line. **On NixOS skip all of this — the flake (below) carries every dependency.** The package names
below are the ones `install.sh` / `scripts/lwe.sh` print; `bash scripts/lwe.sh deps` re-checks the scene group alone.

**Build-time**

| Group | Needed for | Arch | Debian / Ubuntu | Fedora |
|---|---|---|---|---|
| Rust toolchain (`cargo`, `rustc`, edition 2024) | `liascape-player`, `liascape-scene-worker` | `rust` | `cargo rustc` | `cargo rust` |
| Native toolchain + dev headers: `cc`, `make`, `pkg-config`, `wayland-scanner`, wayland / EGL / GLES / `mpv` / `libpulse` / PipeWire / xkbcommon, `libclang` (bindgen) | `liascape-transition`, `liascape-audio`, `liascape-player` | `base-devel wayland wayland-protocols libglvnd mpv libpulse pipewire libxkbcommon clang` | `build-essential libwayland-bin libwayland-dev libegl-dev libgles-dev libmpv-dev libpulse-dev libpipewire-0.3-dev libxkbcommon-dev libclang-dev` | `gcc make wayland-devel mesa-libEGL-devel mesa-libGLES-devel mpv-libs-devel pulseaudio-libs-devel pipewire-devel libxkbcommon-devel clang-devel` |
| Wallpaper Engine scenes — builds LWE's `next-v2` core (`cmake`, `git`, a C++ compiler, SDL2, freetype, glm, lz4, zlib, FFmpeg, mpv, libGL) | `liascape-scene-worker` | `cmake git sdl2 freetype2 glm lz4 zlib ffmpeg mpv libglvnd` | `cmake git libsdl2-dev libfreetype-dev libglm-dev liblz4-dev zlib1g-dev libavformat-dev libavcodec-dev libswresample-dev libswscale-dev libavutil-dev libmpv-dev libgl-dev` | `cmake git SDL2-devel freetype-devel glm-devel lz4-devel zlib-devel ffmpeg-free-devel mpv-libs-devel libglvnd-devel` |
| .NET 10 SDK | the C# backend | `dotnet-sdk` (must be 10.x) | `dotnet-sdk-10.0` (Ubuntu's archive; on Debian add Microsoft's package repo first) | `dotnet-sdk-10.0` |
| Node.js + npm | the React UI and the Electron shell | `nodejs npm` | `nodejs npm` | `nodejs npm` |

*If your distro has no .NET 10 package yet, Microsoft's `dotnet-install.sh` installs the SDK per-user.*

Pass **`--no-scenes`** to `scripts/install.sh` to skip the third row (no `cmake`, SDL2, freetype, glm, lz4 or FFmpeg dev
packages needed): `liascape-scene-worker` is then built without the LWE core, scenes are hidden under `liascape-player` exactly like
"Allow scene support" off, and everything else is unchanged. The scene build fetches the pinned LWE source at build time
(`third_party/lwe/PIN`), so it needs network access.

**Runtime** (needed to run, not to build)

- `mpvpaper` and `mpv` — video wallpapers on the default (`legacy`) engine; `ffmpeg` — thumbnails and frame grabs;
  `libpulse` (`pactl`/`parec`, from `pulseaudio` or `pipewire-pulse`) — Auto-Mute; `wl-clipboard` — keybind Copy buttons.
- Electron is installed by `install.sh` through npm (`app/shell`), not from a distro package.
- `liascape-player` uses libmpv, Wayland, EGL/GLES, xkbcommon and PipeWire at run time (the libraries behind the dev headers
  above), and plays Wallpaper Engine **scenes** from Wallpaper Engine's own `assets/` directory (its Steam install, found
  automatically in your Steam libraries; otherwise set `LIASCAPE_WE_ASSETS_DIR`). Scenes under `liascape-player` do not need the
  `linux-wallpaperengine` binary.
- Optional: `linux-wallpaperengine` — scenes on the default (`legacy`) engine; `playerctl` — the "Only mute if MPRIS
  media player is active" option.

### NixOS (flake)

Requires flakes (`nix.settings.experimental-features = [ "nix-command" "flakes" ];`). The flake builds the self-contained backend, the React UI, and wraps an Electron shell with `ffmpeg`/`mpvpaper`/`linux-wallpaperengine` baked onto its `PATH` — nothing to install by hand.

```bash
# try it (no install)
nix run github:Kryxzort/liascape

# install (imperative)
nix profile install github:Kryxzort/liascape
```

**Declarative** — add the input and reference the package:

```nix
# flake.nix
inputs.liascape.url = "github:Kryxzort/liascape";

# then, in your system/home config
environment.systemPackages = [ inputs.liascape.packages.${pkgs.system}.default ];
```

All three pull the full dependency closure — the app never relies on system libraries, so none of the usual NixOS "missing libssl / libatk / libicu" walls apply.

## Usage

```bash
liascape                     # open the app (Electron GUI)
liascape restore            # re-apply the last wallpaper, no GUI (for autostart)
liascape random             # pick a random wallpaper (from the active playlist if one's running, otherwise the library)
liascape kill               # stop the wallpaper
liascape next               # control the running session (see Compositor keybinds)
liascape ctl state          # what the player shows (its control socket: state, logs, probe, …)
liascape help               # every command
```

Bare `liascape` opens the app; `liascape <command>` runs it headless (`serve` is the local backend the app starts itself).

### Autostart

To restore your wallpaper on login, add to your compositor config:

**Hyprland** (`hyprland.conf`):
```ini
exec-once = liascape restore
```

**Sway** (`config`):
```ini
exec liascape restore
```

### Compositor keybinds

`liascape <action>` controls a running session without opening the UI. Available actions:

- `stop` — stop playback
- `play` — relaunch the last session
- `toggle-play` — stop if playing, otherwise relaunch the last session
- `toggle-pause` — pause/resume playback (and freeze/resume the playlist timer)
- `toggle-mute` — toggle audio mute
- `next` — skip forward in the playlist
- `previous` — go back one wallpaper
- `random` — pick a random wallpaper (from the active playlist if one's running, otherwise the library)
- `volume up` / `volume down` — adjust volume by 5 (persists; clamped 0-100)

The Settings tab provides ready-to-copy snippets for each.

**Hyprland** example:
```ini
bind = SUPER, M, exec, liascape toggle-mute
bind = SUPER, N, exec, liascape next
bind = SUPER, P, exec, liascape toggle-play
```

## Sources

- **motionbgs.com** — large collection of animated wallpapers
- **moewalls.com** — anime-style animated wallpapers
- **desktophut.com** — animated wallpapers
- **Wallpaper Engine** — your local Wallpaper Engine library (Steam workshop). Video wallpapers work out of the box; **Scene** wallpapers require [linux-wallpaperengine](https://github.com/Almamu/linux-wallpaperengine) and must be enabled in Settings → Sources.

## Library

Downloaded wallpapers are saved to `~/.local/share/liascape/library/`. Use the Library tab to apply, delete, or build playlists from them. **Multi-select** with Shift-click / Ctrl-click / Ctrl+A — a toolbar appears at the bottom with bulk actions (Add to Playlist, Remove from Playlist, Delete).

**Import** lets you bring any local video file (mp4, webm, mov, mkv, avi, gif) into the library. A title-input modal opens after you pick the file; liascape copies the video and uses `ffmpeg` to auto-generate a thumbnail.

**Play All** plays your entire library; rotation behaviour follows the global Settings → Playlist panel (timer interval or advance-on-video-end). The **Shuffle** toggle randomizes the order.

## Playlists

Build a custom playlist by clicking the **+** button on any library card. The playlist bar at the bottom of the Library tab supports drag-and-drop reordering. Click any thumbnail to play from that wallpaper, or use the **−** button to remove it from the playlist.

The ⚙ settings popup controls Sequential/Shuffle ordering. Rotation cadence (timer interval or advance-on-video-end) defaults to your global preference; tick **Override global rotation settings** to give a specific playlist its own interval or behaviour.

Save and load named playlists via the toolbar above the playlist bar — playlists are stored in `~/.local/share/liascape/playlists/` as JSON.

## Settings

The Settings tab covers:

- **Playback** — loop, mute, disable cache, and a live volume slider
- **Playlist** — global rotation defaults: switch when video ends, or switch every Hours/Minutes/Seconds. Used by Play All and any playlist that doesn't override the globals.
- **Auto-Mute** — automatically mutes the wallpaper when other audio is playing (e.g. videos, music, calls), with configurable threshold and mute/unmute delays
- **Memory** — mpv demuxer cache size limits
- **Rendering** — hardware decoding (auto / nvdec / vaapi / no), video scale (fill / fit), and an optional FPS cap (videos only; scenes unaffected)
- **Wallpaper Engine** — workshop folder + copy-files toggle

## Building

```bash
bash scripts/dev.sh                              # dev: Vite HMR + dotnet watch (then launch liascape)
cd app/ui && npm run dev                         # UI only, in a browser (append ?api=<backend-port>)
dotnet run --project src/backend -- serve    # backend only (headless local API)
bash scripts/install.sh                          # build UI + backend, install liascape
```

> Packaging: `scripts/PKGBUILD` and `scripts/build-appimage.sh` both build through `scripts/install.sh` (same layout); the Nix flake builds the same layout declaratively.

## License

liascape is licensed under the **GNU GPL v3.0** — see [`LICENSE`](LICENSE). It started as a fork of
[sunwoo101/livepaper](https://github.com/sunwoo101/livepaper); the portions that come from upstream keep their MIT notice in
[`LICENSE.upstream-MIT`](LICENSE.upstream-MIT). The scene worker links
[linux-wallpaperengine](https://github.com/Almamu/linux-wallpaperengine) (GPL-3.0).
