# Decisions

Choices that ruled out a tempting alternative, so nobody "fixes" them back. Format and when to add one:
`.claude/rules/writing-rules.md` § `docs/decisions.md`. The story behind each is in its commit (`git log -S`).

## Backend/API

### Run the agent window in a private compositor, not an output of the session's Hyprland — 2026-11-12
Removing an output always warps the cursor to another monitor's centre (`cursor:no_warps` doesn't stop it), and an output
that stays is a workspace the owner's keys can land on. `scripts/agent-window.sh` only reads Hyprland.

### Serve media from a second listener — 2026-11-12
Chromium's 6 connections per origin filled with slow media loads and API calls queued behind. Media gets the API's
port + 1 (`ApiSecurity.PickPorts`). Rejected: `localhost:<port>` (`[::1]` first, where another user could listen for the
token), HTTP/2 (needs TLS), a random port (races the first thumbnails). Matrix `browse:mediaPool`.

### Authenticate media URLs with `?token=`, not a cookie — 2026-11-11
`<img>`/`<video>` and the WebSocket can't send headers, so GET/HEAD may carry `?token=`; writes need the header. A cookie
is ambient: sent with any request another page triggers (CSRF). `Web/ApiSecurity.cs`.

### Admit the Vite dev origin only while the backend serves no UI — 2026-11-11
Only when `LIASCAPE_UI_DIR` is unset; Vite's `/__liascape/token` answers only `Sec-Fetch-Site: same-origin` and the served
HTML never holds the token. `app/ui/vite.config.ts`.

### Load the `SteamClientLibPath` setting's library, by design — 2026-11-11
A setting naming code to run is a code-execution path; it stays (users point it at their own Steam client), protected by
the API token like every write, not an allow-list.

### Report a missing dependency with a warning, never hide the control — 2026-10-28
Owner: "make missing libraries fail loudly". `/health/features` lists each silent degradation; the UI marks the rows,
which stay usable. `wl-copy` is left out: the UI copies with `navigator.clipboard`.

### Default the volume keys to the playing item's own volume — 2026-10-26
`VolumeKeyTarget=auto`: a new global pushed onto an overridden item snapped back on the next save. `PlayerHelper.AdjustVolume`.

### Reuse the last port across app launches — 2026-10-25
The UI's origin includes the port; a new one per launch reset every localStorage pref. `app/shell/main.js`.

### Forward CLI actions to the running backend — 2026-10-25
Run in a one-shot process, a switch happened behind the backend's back. Never fall back to running locally once the POST
was sent: a doubled next skips one, a doubled toggle undoes itself. `Web/ActionForward.cs`.

### Monitor auto-mute per stream with a 10 ms parec latency — 2026-10-20
`@DEFAULT_MONITOR@` hears our own audio and oscillates; parec's default buffering held the first data ~2 s, 10 ms gets it
in ~65 ms. `Helpers/AudioMonitor.cs`.

## Steam & sources

### Pick a creator's or a scene's list in the filter column — 2026-11-27
Owner's call: Author / Presets of fields the sidebar's rows fill, not top-bar pills. Steam can't search authors, so a bare
word is never tried as a profile name (a request per typo). `Helpers/SteamAuthors.cs`, probe-steam `list:*`.

### Browse the Workshop over Steam's client protocol, anonymously — 2026-11-11
Scraping the browse page (30 a page, AND-only tags, a read per detail) trips Steam's per-IP limit and locks the user's
browser out too; `QueryFiles` gives 100 a page with tags and previews. One shared session: its logon costs more than a page.

### Gate every steamcommunity.com request app-wide — 2026-11-11
Owner's call: Steam must never block the user's IP, so no code path can burst on its own. `Helpers/SteamGate.cs`.

### AND Workshop features, OR genres, each switchable — 2026-11-11
Features stack on one item (Steam ANDs them); an item usually has one genre, so AND would find nothing. Owner asked for
an all/any switch on both. `WorkshopTags.Build`.

### Drop untagged items under any age filter — 2026-11-11
Owner: "a 'everyone' user encountering a untagged 'mature' is a tragedy". `WorkshopTags.Build`.

### Offer two Workshop download modes, the Steam page the last resort — 2026-11-26
`steamapp` (no login given to Liascape) and `subscribe`; what the mode can't do falls to the sign-in (when usable under
`steamapp`: the user gave that trust), then the Steam page, which needs no login and so never exceeds the trust chosen.
Replaced a third mode and "no mode uses another's way". `.claude/rules/backend/sources-steam.md`.

### Drive the Steam client through its own `steamclient.so` — 2026-11-11
`libsteam_api.so` is Valve's redistributable, not ours to ship. A short-lived child calls ISteamUGC by vtable slot.

### Hold the Steam app connection while the Liascape window is open — 2026-11-26
Connected, Steam shows "Playing Wallpaper Engine": a connection per download blinked it (a friends' popup each), one per
Browse visit blinked as the user moved tabs, and one for the backend's lifetime would show the user in-game all day and
pause Steam's downloads. `scripts/test-steam-app-hold.sh`.

### Queue the Steam pages the user must click, one at a time, advanced by Next — 2026-11-11
Steam shows one page, so N at once lost all but one. Steam's subscribed state is never read (it needs a client connection
the page route avoids). The one auto-advance (owner's ask): a subscribe entry whose files appear. `Web/SteamTodo.cs`.

### Report Workshop download phases, not a percent — 2026-11-11
Steam may reserve a file's full size before writing it, so a size-based percent sat empty for a minute.

### Open an unsubscribe page only for items in a Steam Workshop folder — 2026-11-11
An owned `workshop/<id>` copy (a one-off) is never a subscription. `WorkshopDownloader.UnsubscribeInSteamApp`.

### Offer a password sign-in beside the QR — 2026-11-11
The QR needs the Steam mobile app. Nothing retries a sign-in by itself: repeated attempts extend Steam's block.

### Keep Steam tokens in the system keyring, a 0600 file as fallback — 2026-11-11
Owner's call: settings.json is posted by the UI and read by every process. Keyring-only would break sign-in on bare
compositors; the file is as safe as Chromium's "basic" store. `Helpers/SecretStore.cs`.

### Show Favourites and In my library as sets in the filter column — 2026-11-21
Owner's call: favourites are a subset of the Workshop, so a three-way row in group Yours (from a cache, local search and
sorts), not a pill swapping Browse to Steam's favourites list (no search, two sorts). Probe-steam `yours:*`.

### Ask Steam for a whole library's details in one request; never cache "can't tell" as "none" — 2026-11-12
CM `GetDetails` takes 1000 ids (100–1000 all came back in ~600 ms; the web API's ~200 cap is a URL length). A failed check
stores nothing (WE's offline mode caches "none" for good). `Web/LibraryFactsOps.cs`.

### Keep the Workshop in Steam's own sort orders — 2026-06-02
Results arrive page by page in Steam's order; a client-side sort would reshuffle what infinite scroll loaded. Lists held
whole sort client-side.

## Library

### Play a preset as its own item over its base scene's folder — 2026-11-20
Copying the scene into each preset costs hundreds of MB each, goes stale when the base updates and fights the overrides.
`.claude/rules/backend/library.md` § Presets.

### Remove only the link when a watched folder's file goes — 2026-11-18
A copy stays as the user's own; nothing leaves while the folder is missing or empty (an unmounted drive).

### Normalize video loudness with one fixed gain capped by the true peak — 2026-11-11
`g = min(target − I, −1 − TP)`: a quiet item with big peaks plays under the target, no limiter (the owner checked the worst
by ear). ffmpeg's `loudnorm` at playback falls back to dynamic mode for a third of videos and pumps.

### Set scene normalization once per play — 2026-11-06
Owner decision: gain moving mid-play is audible, so a playing scene keeps its gain until its first 60 s window lands, then
once more at most. `.claude/rules/backend/player-adapter.md` § Scenes and loudness.

### Leave file-picker scene properties uneditable — 2026-10-28
`scenetexture`, `file` and `directory` need a picker and `usershortcut` launches a Windows app: listed with a reason.

## Settings & state

### Order card previews in two lists, not toggles — 2026-11-15
"On hover" / "Not hovered" each order video / GIF / still; three toggles couldn't say every order. Matrix `appear:previewOrder`.

### Use four settings levels, Standard by default, and never reset a hidden value — 2026-11-06
Owner's final call: Basic · Standard · Advanced · Expert. A hidden changed value gets the "tucked away" note; a bulk reset
also reset deliberate choices. `src/settingsLevel.ts`.

### Fold "Resume from last" into the playlist start setting — 2026-11-01
A single wallpaper always comes back at its position; a playlist follows "When the playlist starts again".

### Use one interval field: "Switch every" or "Minimum play time" — 2026-10-28
Advance-on-end off: a timer; on: the same value is the minimum and `MaxPlaySeconds` the maximum.
`.claude/rules/backend/player-adapter.md` § Rotation.

## UI

### One sidebar for an item, the same on both tabs — 2026-11-27
Two copies drifted: `components/ItemSide.tsx` serves both tabs. Right-click opens it, so a card menu at the pointer
collides (tried, reverted): Hide and Unsubscribe are its actions. Hide only hides, per grid. Probe-hidden `same:*`.

### Teach in place, never with a step-by-step tour — 2026-11-26
A welcome in the empty Library, one dismissible tip per non-obvious thing where it is met. `--probe probe-firstrun.js`.

### Let input pass through the window's opening, never end it — 2026-11-26
Input already works through it at full speed, so a skip would only cut the library's arrival short. Probe-intro
intro:click, intro:key, intro:scroll.

### A lone video always loops — 2026-11-14
No "Loop videos" switch: play-once-and-freeze is too niche for a setting that freezes every video.

### Left click does the tab's main action, right click opens the item sidebar — 2026-11-14
A click applies in the Library and opens the item in Browse; right-click opens the sidebar everywhere, applying nothing; no
item menus. `.claude/rules/ui/design.md` § Interaction rules.

### Fade, never move, with motion off — 2026-11-12
Motion off serves people sensitive to motion and people saving its cost: an opacity fade moves nothing and runs on the
compositor, while an instant change makes panels pop. `.claude/rules/ui/design.md` § Motion off.

### Let a hidden gif preview keep its own clock; hold its frame only as a video — 2026-11-18
Holding a gif's frame needs our own decoder (40 gifs: twice the renderer CPU, ~400 MB); only "Play GIF previews as videos"
holds it. Matrix `appear:gifResume`, `appear:gifVideo`.

### Play every on-screen video preview, each as a small clip — 2026-11-18
The wallpaper's file holds a connection. Owner's terms: no storage options; one clip per item, sized to its box, on the one
preview worker and line. `scripts/test-clip-sweep.sh`, matrix `clip:*`.

### Keep the Library page mounted across tab switches; don't virtualise the grid — 2026-11-12
`content-visibility` already skips off-screen cards; the cost was the rebuild, and windowing breaks keyboard reveal, box
selection, locate-playing and probes. Probe-layout `tabs:keep`, `perf:tabs`.

### Make the UI itself a work of art — 2026-11-12
Every control designed, not defaulted; "correct and consistent" is the floor, within the toggles and the frame budget.
`.claude/rules/ui/design.md`.

### Show tooltips only for what can't be seen — 2026-11-11
Owner: "not everything needs a tooltip". `.claude/rules/ui/design.md` § Interaction rules.

### Show focus rings only while tabbing — 2026-11-11
Owner: no outlines on clicks. Chromium rings a clicked button after any key; `.kbd-nav` limits it to Tab. `hooks/focusRing.ts`.

### Make the sidebar's picture the Play control — 2026-11-11
The Play row was "redundant clutter": the picture is the button, a playing item gets a green frame.

### Open previews on the gif or still, never the video, and remember the pick per sidebar — 2026-11-11
Owner: "dont force mp4 when the preview is a still image". Browse items rarely have a video, so the pick isn't shared.

### Loop trailers on the player's "ended", not YouTube's `loop=1` — 2026-11-11
YouTube's loop restarted early. `components/YouTubeEmbed.tsx`.

### Filter the Library and the local Wallpaper Engine folder in the page — 2026-11-12
Owner's call: the Workshop's column, matched in the page against saved tags, else project.json. Each list keeps its own
filter (a shared one empties a local list); not a backend filter (a request per click is slower). Probe-filters `lib:*`.

### Filter the Workshop in a column of three-way switches — 2026-11-11
Owner's pick over dropdowns and chips; clicking a name only includes, so hiding is deliberate. On the right, one panel at
a time with the item sidebar (left column, pill, edge handle rejected). Probe-filters `split:*`, `panel:*`.

### Keep the playlist bar's items 112 px tall at every Thumbnail shape; the dock aims at a fixed rise — 2026-11-12
A fixed width made widescreen items too small and the bar's height move; a 1.16× magnify needed a header gap the owner
found too big. `hooks/useDockLift.ts`; probe-plbar `bar:shape`.

### Bounce the playlist bar's dock only when entering, stopping or leaving — 2026-11-11
A bounce on every item during a sweep stutters. Probe-plbar `bar:bounce`.

### Travel to the playing wallpaper once per session, spotlit in the playing green — 2026-11-10
Never again that session, so a later switch never moves the user's scroll; green is what the playing item already pulses.

### Replace the card settings and preview modals with an item sidebar — 2026-11-10
Owner asked for a Wallpaper Engine-style sidebar. `.claude/rules/ui/design.md` § Item sidebar.

### Default NVIDIA to hardware GL through ANGLE on EGL — 2026-10-28
SwiftShader cost CPU every frame; native Wayland wants Vulkan and XWayland crashed the GPU process. `LIASCAPE_SOFTGL=1`
brings SwiftShader back. `app/shell/main.js`.

### Let numeric fields be emptied while focused — 2026-10-28
Owner: empty the field freely; snap to the minimum only on focus out. `components/NumInput.tsx`.

### Use the app's own dropdown, never a native `<select>` — 2026-06-24
Native selects can't be themed, made translucent or smooth-scrolled on Chromium/Linux.

### Never blur behind panels (`backdrop-filter`) — 2026-06-24
Its paint cost, and the owner's request; translucency is `--tr` / `--tr-strong`.

## Player (`liascape-player`)

### Skip only non-reference frames at a fast speed, only once mpv falls behind — 2026-11-26
Measured at 2× on a 4K120 clip: `framedrop=decoder+vo` gave 42 uneven frames/s, `framedrop=no` drifted from the audio,
`bidir` breaks P-frames; a speed or frame-rate threshold alone would halve clips the decoder handles.

### Make liascape-player the only engine, no fallback — 2026-11-22
Owner: "even with issues, it's better than the previous engine". A missing binary is an error with its reason; a
regression is a bug to fix. `scripts/test-player-binary.sh`.

### Keep the pointer's arrival jump, not WE's first-frame corner stroke — 2026-11-20
Owner: WE's stroke from 0,0 is a quirk. `scene_fps_quirks.py` cancels it with a parked pointer.

### Decode scene video textures with FFmpeg, not mpv — 2026-11-20
Owner's call over an mpv patch only the flake could ship: FFmpeg's `primary_ctx` gives one CUDA context on every install.

### Scene fonts come from fontconfig, not a Windows install — 2026-11-18
Owner's call: Microsoft's fonts pass on only inside their installers, so nothing ships or reads them from a Windows partition.

### Keep a spare scene worker while scenes play or are in the rotation — 2026-11-18
Owner's call: ~60 MiB PSS is worth 65–135 ms off each scene apply; video-only users pay nothing.

### Run one scene worker per scene source, not per output — ~2026-10-27
Owner's call: half the GPU time and VRAM, the animation in sync across monitors; per-output rate is a present gate.

### Default `scene_fps` to WE's own `fps` (15), not capped by the refresh rate — 2026-10-27
Owner's call, from WE's frame limiter: scenes run at their author's rate, not the monitor's.

### A scene's minimum play time beats its maximum — ~2026-11
Owner's call: a maximum below the minimum is raised to it on save, never refused.

### Count a GPU context loss as a crash restart, through the same budget — 2026-10-28
The protocol carries no reset kind, so a separate allowance could loop forever.

### Spawn scene workers on the loop with `posix_spawn` — 2026-10-27
A spawn thread makes the pid late for every kill and reap path; never `fork` (the player's memory is never copied).

### Lower only the scene worker's GL context priority, never a load's CPU priority — ~2026-10-27
`High` on the compositor's contexts did nothing measurable; `nice` / `SCHED_IDLE` stretched a load 10× under contention.

### Default `__NV_DISABLE_EXPLICIT_SYNC=1` and drain libwayland's default queue every iteration — 2026-10-25
egl-wayland2 ≤ 1.0.2 leaks one `wl_closure` per present otherwise (loop p99 ≈ 1.6 ms). `src/player/src/wl.rs`.

### Decode loop-rendered sources in copy modes only — 2026-10-25
mpv's own interop and `auto` order cost 65–320 ms per switch on the loop; zero-copy only on render-worker lanes.

### Fix glibc's mmap threshold at 128 KiB and trim after each reaper batch — 2026-10-25
Freed decoder buffers pinned RSS. `M_ARENA_MAX` was rejected: nothing measurable, more lock contention.

### Keep the animator tick timer running while every output is idle — ~2026-10-25
About 23 µs a tick; stopping it means every start, phase, step and stop path re-arming it, and a missed one freezes an animation.

## Build & distribution

### Make the user command a shell launcher, not the C# binary — 2026-10-28
The GUI and `liascape ctl` need neither .NET's startup nor its runtime; one script serves install.sh, the AppImage and the
flake. `scripts/liascape`.
