# livepaper

A live wallpaper manager for Wayland. Browse and download animated wallpapers from online sources, or play wallpapers directly from your local Wallpaper Engine library — all applied to your desktop using [mpvpaper](https://github.com/GhostNaN/mpvpaper) (and [linux-wallpaperengine](https://github.com/Almamu/linux-wallpaperengine) for scenes).

The interface is an **Electron + React** app over a **headless C# backend** — the same `livepaper` binary runs the CLI, the background daemons, and a local web API that the UI talks to.

![livepaper](docs/app.png)

## Requirements

- Wayland compositor (Hyprland, Sway, GNOME on Wayland, etc.)
- [mpvpaper](https://github.com/GhostNaN/mpvpaper)
- `ffmpeg` (auto-generates thumbnails when importing videos)
- `libpulse` (provides `pactl`/`parec` for Auto-Mute; satisfied by either `pulseaudio` or `pipewire-pulse` on Arch)
- `wl-clipboard` (`wl-copy` keeps Settings-tab snippets on the clipboard after livepaper closes)
- .NET 10 SDK **and** Node.js / npm (for building from source — the C# backend and the React UI respectively)

### Optional

- `playerctl` — required for the "Only mute if MPRIS media player is active" Auto-Mute option; without it the option has no effect
- [linux-wallpaperengine](https://github.com/Almamu/linux-wallpaperengine) — required for Wallpaper Engine **scene** support (enable in Settings → Sources → "Allow scene support")

## Installation

### AUR

```bash
yay -S livepaper-git
```

> ⚠️ The AUR package currently still builds the **legacy single-binary app**, not this Electron+backend rewrite. Until the `PKGBUILD` is updated, install from source.

### From source

```bash
git clone https://github.com/sunwoo101/livepaper.git
cd livepaper
bash scripts/install.sh
```

Builds the React UI, publishes the self-contained C# backend, and installs **`livepaper`** to `~/.local/bin` (bare = open the GUI; flags = CLI/daemons), plus **`livepaper-ui`** (explicit GUI launcher) and a desktop entry.

## Usage

```bash
livepaper                     # open the app (Electron GUI)
livepaper --restore           # re-apply the last wallpaper, no GUI (for autostart)
livepaper --random            # pick a random wallpaper (from the active playlist if one's running, otherwise the library)
livepaper --kill              # stop the wallpaper
livepaper --action=<action>   # control the running session (see Compositor keybinds)
```

Bare `livepaper` opens the GUI; any flag runs the headless side (`--serve` is the local backend the GUI talks to). `livepaper-ui` also launches the GUI directly.

### Autostart

To restore your wallpaper on login, add to your compositor config:

**Hyprland** (`hyprland.conf`):
```ini
exec-once = livepaper --restore
```

**Sway** (`config`):
```ini
exec livepaper --restore
```

### Compositor keybinds

`--action=<action>` controls a running session without opening the UI. Available actions:

- `stop` — stop playback
- `play` — relaunch the last session
- `toggle-play` — stop if playing, otherwise relaunch the last session
- `toggle-pause` — pause/resume playback (and freeze/resume the playlist timer)
- `toggle-mute` — toggle audio mute
- `next-wallpaper` — skip forward in the playlist
- `previous-wallpaper` — go back one wallpaper
- `random` — pick a random wallpaper (from the active playlist if one's running, otherwise the library)
- `volume-up` / `volume-down` — adjust volume by 5 (persists; clamped 0-100)

The Settings tab provides ready-to-copy snippets for each.

**Hyprland** example:
```ini
bind = SUPER, M, exec, livepaper --action=toggle-mute
bind = SUPER, N, exec, livepaper --action=next-wallpaper
bind = SUPER, P, exec, livepaper --action=toggle-play
```

## Sources

- **motionbgs.com** — large collection of animated wallpapers
- **moewalls.com** — anime-style animated wallpapers
- **desktophut.com** — animated wallpapers
- **Wallpaper Engine** — your local Wallpaper Engine library (Steam workshop). Video wallpapers work out of the box; **Scene** wallpapers require [linux-wallpaperengine](https://github.com/Almamu/linux-wallpaperengine) and must be enabled in Settings → Sources.

## Library

Downloaded wallpapers are saved to `~/.local/share/livepaper/library/`. Use the Library tab to apply, delete, or build playlists from them. **Multi-select** with Shift-click / Ctrl-click / Ctrl+A — a toolbar appears at the bottom with bulk actions (Add to Playlist, Remove from Playlist, Delete).

**Import** lets you bring any local video file (mp4, webm, mov, mkv, avi, gif) into the library. A title-input modal opens after you pick the file; livepaper copies the video and uses `ffmpeg` to auto-generate a thumbnail.

**Play All** plays your entire library; rotation behaviour follows the global Settings → Playlist panel (timer interval or advance-on-video-end). The **Shuffle** toggle randomizes the order.

## Playlists

Build a custom playlist by clicking the **+** button on any library card. The playlist strip at the bottom of the Library tab supports drag-and-drop reordering. Click any thumbnail to play from that wallpaper, or use the **−** button to remove it from the playlist.

The ⚙ settings popup controls Sequential/Shuffle ordering. Rotation cadence (timer interval or advance-on-video-end) defaults to your global preference; tick **Override global rotation settings** to give a specific playlist its own interval or behaviour.

Save and load named playlists via the toolbar above the strip — playlists are stored in `~/.local/share/livepaper/playlists/` as JSON.

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
bash scripts/dev.sh                              # dev: Vite HMR + dotnet watch (then launch livepaper-ui)
cd app/ui && npm run dev                         # UI only, in a browser (append ?api=<backend-port>)
dotnet run --project src/livepaper -- --serve    # backend only (headless local API)
bash scripts/install.sh                          # build UI + backend, install livepaper + livepaper-ui
```

> Packaging (AppImage / AUR) is **not** rebuilt for the Electron stack yet — `scripts/build-appimage.sh` + `PKGBUILD` still target the old single-binary app. Use `scripts/install.sh` for now.
