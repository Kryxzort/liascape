# Liascape

Liascape puts live wallpapers on your Wayland desktop. It plays videos, GIFs, pictures and Wallpaper Engine
wallpapers, including Wallpaper Engine's interactive scenes, and gives you one place to find them, keep them and
rotate through them.

You browse a few wallpaper sites and the Steam Workshop from inside the app, download what you like into your library,
and apply it with a click. Build a playlist and Liascape switches wallpapers on a timer or when a video ends, with an
animated transition between them. Once you close the window, the wallpaper keeps playing.

<!-- Outdated: this screenshot shows an old version of the app. A new one needs a clean, sandboxed library (no personal wallpapers or accounts in view). -->
![Liascape](docs/app.png)

**Status: pre-release.** Video, GIF and picture wallpapers, the library, playlists, transitions and all the
wallpaper sources work every day. The new built-in player (`liascape-player`) and Wallpaper Engine scenes on it are
experimental. There are no packages yet: you install from source or with Nix. Settings and file formats may still
change between versions.

## What it does

**Finds wallpapers.** The Browse tab searches MotionBgs, Moewalls, Desktophut and the Wallpaper Engine Steam
Workshop. You can browse the Workshop without signing in: filter by tags and age rating, sort the way Steam does, read
comments, and see a creator's other wallpapers. Your local Wallpaper Engine folder shows up as a source too.
Wallpaper Engine's web, application and preset wallpapers don't play yet, so Browse leaves them out.

**Keeps a library.** Downloads land in your library, and so does anything new in your Wallpaper Engine Workshop folder
(you can turn that off). Import your own videos, GIFs and pictures with the Library tab's Import button. Click a card to
apply it. Right-click it to open its sidebar, where you can set that wallpaper's own volume and speed, and change a
scene's own options.

**Rotates them.** Mark cards for the playlist and press Play. By default a video plays to its end and then the next
one starts; scenes and pictures switch after 30 minutes. You can switch on a fixed timer instead, set a minimum and
maximum play time, shuffle, and save and load named playlists. Any playlist can override the global rotation settings.

**Switches smoothly.** Turn on transitions (Settings → Playlist & rotation → Transitions) and pick from over a hundred animated
effects from the [gl-transitions](https://github.com/gl-transitions/gl-transitions) collection. The sound crossfades
too.

**Minds the sound.** Audio normalization evens out loudness between wallpapers. Auto-mute quiets the wallpaper while
another app plays sound, and can be limited to media players such as Spotify or a browser. Both start off; turn them
on in Settings → Sound and Settings → Auto-mute.

**Stays out of the way.** With `liascape-player`, the wallpaper pauses while a maximized or fullscreen window covers
it, eases off a scene that makes your GPU stutter, and can stop scenes that use too much video memory. If a scene
crashes, only that scene is affected: it restarts, and after three crashes in a minute it shows a still picture.

## Two players

Liascape has two ways to draw the wallpaper. You choose in Settings → Under the hood → Player engine (set the
settings level at the top to Advanced to see it). It switches live.

- **Legacy** is the default today. It plays videos with [mpvpaper](https://github.com/GhostNaN/mpvpaper) and scenes
  with [linux-wallpaperengine](https://github.com/Almamu/linux-wallpaperengine), which you install yourself.
- **liascape-player** is the new all-in-one player, built with Liascape. It plays videos, pictures and scenes itself
  (scenes need no separate program) and adds pausing behind windows, the GPU and video memory settings, and Windows
  fonts in scenes. It's marked experimental and will replace the legacy player.

## What you need

- A Wayland compositor that supports the wlr-layer-shell protocol, such as Hyprland, Sway or KDE Plasma. GNOME doesn't
  support it, so Liascape can't draw a wallpaper there.
- An x86-64 Linux machine.
- For Wallpaper Engine scenes: Wallpaper Engine installed through Steam. Liascape uses its asset files and looks for
  it in your Steam libraries.
- For Workshop downloads: Steam. Settings → Getting Workshop wallpapers offers four ways to get them: through the
  running Steam app, by opening the item's page in Steam, by subscribing with a Steam login inside Liascape (the
  default), or by downloading with `steamcmd`.

Scenes that name a Windows font (Arial, Consolas and so on) look closest to Windows when a Windows drive is mounted:
`liascape-player` finds its Fonts folder by itself (or you pick one) and reads the fonts where they are. Nothing is
copied.

## Install

There's no AUR package or AppImage yet. `scripts/PKGBUILD` builds the current app but hasn't been tested on Arch
yet, and the AppImage script hasn't been updated, so use Nix or build from source.

### NixOS and Nix

The flake brings its own Electron, mpvpaper, linux-wallpaperengine and ffmpeg, so you don't install those yourself.
You need flakes enabled (`nix.settings.experimental-features = [ "nix-command" "flakes" ];`).

```bash
nix run github:Kryxzort/liascape             # try it without installing
nix profile install github:Kryxzort/liascape # install it
```

Or add it to your system config:

```nix
# flake.nix
inputs.liascape.url = "github:Kryxzort/liascape";

# your configuration
environment.systemPackages = [ inputs.liascape.packages.${pkgs.system}.default ];
```

### Other distros: build from source

```bash
git clone https://github.com/Kryxzort/liascape.git
cd liascape
bash scripts/install.sh
```

This builds everything and installs the `liascape` command to `~/.local/bin` with a desktop entry, so make sure
`~/.local/bin` is on your `PATH`. Before building, the script checks the Rust and native toolchains and the scene
build dependencies and stops with the exact package line for Arch, Debian/Ubuntu and Fedora if something is missing.
It doesn't check for .NET or Node.js, so install those first (see below).

Add `--no-scenes` to skip Wallpaper Engine scene support in `liascape-player`. That needs fewer packages and changes
nothing else. Building with scenes downloads the linux-wallpaperengine source, so it needs network access.

The script doesn't install Electron, which runs Liascape's window. Put an `electron45` or `electron` binary on your
`PATH` (on Arch, `electron45-bin` from the AUR) or point `LIASCAPE_ELECTRON` at one. Liascape targets Electron 45; versions older than 42
are known to crash on NVIDIA. Only the window needs Electron: the commands work without it.

<details>
<summary>Build dependencies</summary>

| For | Arch | Debian / Ubuntu | Fedora |
|---|---|---|---|
| Rust (edition 2024) | `rust` | `cargo rustc` | `cargo rust` |
| Native toolchain and headers | `base-devel wayland wayland-protocols libglvnd mpv libpulse pipewire libxkbcommon clang` | `build-essential libwayland-bin libwayland-dev libegl-dev libgles-dev libmpv-dev libpulse-dev libpipewire-0.3-dev libxkbcommon-dev libclang-dev` | `gcc make wayland-devel mesa-libEGL-devel mesa-libGLES-devel mpv-libs-devel pulseaudio-libs-devel pipewire-devel libxkbcommon-devel clang-devel` |
| Wallpaper Engine scenes (skip with `--no-scenes`) | `cmake git sdl2 freetype2 fontconfig harfbuzz glm lz4 zlib ffmpeg mpv libglvnd` | `cmake git libsdl2-dev libfreetype-dev libfontconfig-dev libharfbuzz-dev libglm-dev liblz4-dev zlib1g-dev libavformat-dev libavcodec-dev libswresample-dev libswscale-dev libavutil-dev libmpv-dev libgl-dev` | `cmake git SDL2-devel freetype-devel fontconfig-devel harfbuzz-devel glm-devel lz4-devel zlib-devel ffmpeg-free-devel mpv-libs-devel libglvnd-devel` |
| .NET 10 SDK | `dotnet-sdk` (10.x) | `dotnet-sdk-10.0` | `dotnet-sdk-10.0` |
| Node.js and npm | `nodejs npm` | `nodejs npm` | `nodejs npm` |

If your distro has no .NET 10 package, Microsoft's `dotnet-install.sh` installs the SDK for your user.
`bash scripts/lwe.sh deps` checks the scene row on its own.

</details>

<details>
<summary>Programs Liascape uses at run time</summary>

- `ffmpeg` (with `ffprobe`): thumbnails, imports, video previews, video lengths and loudness measuring.
- Legacy player only: `mpvpaper` and `mpv` for videos, `linux-wallpaperengine` for scenes, `pactl` and `parec`
  (from `libpulse` or `pipewire-pulse`) for auto-mute, and `playerctl` for "Only mute for media players".
  `liascape-player` needs none of these.
- Optional: `secret-tool` (libsecret) keeps your Steam sign-in in the system keyring. Without it, the sign-in is kept
  in `~/.config/liascape/steam-auth.json`, readable only by you.
- Optional: `steamcmd`, for the "Download via steamcmd" mode.

If something a feature you use needs is missing, Settings says so at the top: what doesn't work and why.

</details>

## Using it

Run `liascape` or open Liascape from your app launcher. The app has three tabs: **Browse**, **Library** and
**Settings**.

Settings has four levels, picked at the top while the Settings tab is open: Basic, Standard (the default), Advanced
and Expert. Each level shows more settings. A setting you changed keeps working when its level is hidden, and a note
at the top of Settings tells you about it.

### Restore your wallpaper at login

Add `liascape restore` to your compositor's startup. It puts back what was playing without opening the window.

```ini
# Hyprland (hyprland.conf)
exec-once = liascape restore

# Sway (config)
exec liascape restore
```

### Keybinds

Every action is a command you can bind to a key. When the app is open, the command goes to it; otherwise it runs on
its own.

```text
liascape next | previous     the next or previous wallpaper
liascape random              a random wallpaper from the playing playlist, else your library
liascape play | stop | toggle-play
liascape toggle-pause        pause or resume (the rotation timer pauses too)
liascape toggle-mute
liascape volume up | down    5 steps; the global volume or the playing wallpaper's own
liascape toggle-loop-current keep the current wallpaper looping, no rotation; again to rotate
liascape kill                stop the wallpaper without asking the open app
liascape help                every command
```

For example, in Hyprland:

```ini
bind = SUPER, N, exec, liascape next
bind = SUPER, M, exec, liascape toggle-mute
bind = SUPER, P, exec, liascape toggle-pause
```

Settings → Keyboard shortcuts lists each command with a Copy button.

### Where your things are kept

- Your library: `~/.local/share/liascape/library/`
- Saved playlists: `~/.local/share/liascape/playlists/`
- Settings: `~/.config/liascape/`

Wallpapers from your Workshop folder are linked into the library, not copied, unless you turn on "Copy files instead
of linking".

## Reporting a problem

A scene that won't load or doesn't look like it does in Wallpaper Engine? Open an issue with the
"A scene looks wrong" form: the Workshop link and a screenshot are all it needs. For anything else, use
"Something's broken" or "Idea or request".

## Contributing and building

`CLAUDE.md` lists how to build, run and test each part. The player's design is in
[`docs/player/architecture.md`](docs/player/architecture.md), and [`docs/decisions.md`](docs/decisions.md) explains
choices that might look odd.

## License and credits

Liascape is licensed under the [GNU GPL v3.0](LICENSE). It started as a fork of
[sunwoo101/livepaper](https://github.com/sunwoo101/livepaper); the parts that come from it keep their MIT notice in
[`LICENSE.upstream-MIT`](LICENSE.upstream-MIT).

Scenes are drawn by a fork of [linux-wallpaperengine](https://github.com/Almamu/linux-wallpaperengine)
(GPL-3.0). `liascape-player` reuses techniques from [mpvpaper](https://github.com/GhostNaN/mpvpaper) (GPL-3.0), and the
transition effects come from [gl-transitions](https://github.com/gl-transitions/gl-transitions) (MIT).
[`CREDITS.md`](CREDITS.md) lists what came from where, and [`UPSTREAM.md`](UPSTREAM.md) how each is tracked.

Liascape isn't affiliated with Wallpaper Engine or Valve.
