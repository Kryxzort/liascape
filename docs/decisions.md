# Decisions

Choices that ruled out a tempting alternative, so nobody "fixes" them back. Format and when to add one:
`.claude/rules/writing-rules.md` § `docs/decisions.md`. The story behind each is in its commit (`git log -S`).

## Backend/API

### Run the agent window in a private compositor, not an output of the session's Hyprland — 2026-11-12
Agents drive their own Liascape window (`scripts/agent-window.sh`) in a headless gamescope, never a headless output
added to the owner's Hyprland: removing an output always warps the cursor to another monitor's centre
(`CMonitor::onDisconnect`; `cursor:no_warps` doesn't stop it), and an output that stays is a workspace the owner's keys
can land on. The script only reads Hyprland. `.claude/rules/ui/shell-and-probes.md`.

### Serve media from a second listener — 2026-11-12
Chromium opens 6 HTTP/1.1 connections per origin; slow media loads held them all and API calls queued behind. Media
gets its own listener at the API's port + 1 (`ApiSecurity.PickPorts`), answering only token-carrying GETs of the media
routes; the page derives it (`api/client.ts` `MEDIA`). Rejected: `localhost:<port>` (Chromium tries `[::1]` first, where
another local user could listen and collect the token), HTTP/2 (needs TLS), a random port (races the first thumbnails).
`.claude/rules/backend/api.md`; matrix `browse:mediaPool`.
### Authenticate media URLs with `?token=`, not a cookie — 2026-11-11
Every page in the user's browser and every local user can reach `127.0.0.1`, so the API needs a capability only the
app's page holds. `<img>`/`<video>` src and the WebSocket can't send headers, so GET/HEAD may carry `?token=`; writes need
the header. A cookie was rejected: it is ambient, sent with any request another page triggers (CSRF again).
Enforced in `Web/ApiSecurity.cs`; `.claude/rules/backend/api.md` § Security.

### Admit the Vite dev origin only while the backend serves no UI — 2026-11-11
The dev UI on :5173 is a foreign origin; it is allowed only when `LIASCAPE_UI_DIR` is unset (`dotnet watch -- serve`),
never in production. Vite's dev-only `/__liascape/token` answers only a `Sec-Fetch-Site: same-origin` request (set by the
browser, not forgeable by another site), and the served HTML never contains the token. `app/ui/vite.config.ts`.

### Load the `SteamClientLibPath` setting's library, by design — 2026-11-11
A setting that names code to run is a code-execution path. It stays (users point it at their own Steam client) and is
protected by the API token like every other write, not by an allow-list. Every spawn passes an argument list.

### Report a missing dependency with a warning, never hide the control — 2026-10-28
Owner: "make missing libraries fail loudly". `/health/features` lists each dependency that silently degrades a feature and
the UI puts a `WarnIcon` on the affected rows, which stay usable. `wl-copy` is left out on purpose: the UI copies with
`navigator.clipboard`. `.claude/rules/backend/api.md` § Feature health.

### Default the volume keys to the playing item's own volume — 2026-10-26
`VolumeKeyTarget=auto` moves the playing item's override when it has one, else the global. Pushing a new global onto an
overridden item made it snap back on the next settings save. `item` and `global` stay for users who want one target.
`PlayerHelper.AdjustVolume`; `.claude/rules/backend/api.md` § Endpoint conventions.

### Reuse the last port across app launches — 2026-10-25
The production UI's origin is `http://127.0.0.1:<port>`; a new random port per launch reset every localStorage pref.
The shell passes the previous port as `LIASCAPE_PORT` while it is free. `app/shell/main.js`.

### Forward CLI actions to the running backend — 2026-10-25
`liascape next` and the other keybind actions go to the running backend (`POST /action`) so the UI hears about them; run
in a one-shot process a switch happened behind the backend (stale history, the wrong item marked playing). Never fall
back to running locally once the POST was sent: a doubled next skips one, a doubled toggle undoes itself.
`Web/ActionForward.cs`; `.claude/rules/backend/api.md` § CLI forwarding.

### Monitor auto-mute per stream with a 10 ms parec latency — 2026-10-20
`@DEFAULT_MONITOR@` hears our own audio and oscillates, so each foreign stream is monitored on its own. parec's default
buffering held the first data ~2 s; `--latency-msec=10` gets it in ~65 ms. `Helpers/AudioMonitor.cs`
(`.claude/rules/backend/player-adapter.md` § Auto-mute).

## Steam & sources

### Browse the Workshop over Steam's client protocol, anonymously — 2026-11-11
Scraping steamcommunity.com's browse page (30 items a page, AND-only tags, a page read per detail) trips Steam's per-IP
limit, locking the user's browser out for 30+ min too. `PublishedFile.QueryFiles` gives 100 items a page with tags,
previews and descriptions; the scraper is the fallback only. One shared session: connect + logon (1.2–2.6 s) costs more
than a page (0.5–1.3 s). `Helpers/SteamAnonymous.cs`.

### Gate every steamcommunity.com request app-wide — 2026-11-11
Owner's call: Steam must never block the user's IP. One gate spaces request starts and turns a 429
into a cooldown persisted across restarts, so no code path can burst on its own. `Helpers/SteamGate.cs`;
`.claude/rules/backend/sources-steam.md` § Steam Community rate limits.

### AND Workshop features, OR genres, each switchable — 2026-11-11
Feature tags stack on one item and Steam's own page ANDs them; an item usually has one genre, so AND would find almost
nothing. The owner asked for an all/any switch on both; defaults are features all,
genres any. `Helpers/WorkshopTags.cs` `Build`.

### Drop untagged items under any age filter — 2026-11-11
Owner: "a 'everyone' user encountering a untagged 'mature' is a tragedy". Any age include or exclude becomes a taggroup
of the allowed ages, which drops the few hundred items with no age tag; other groups' excludes keep untagged items.
`WorkshopTags.Build`.

### Offer two Workshop download modes, the Steam page the last resort — 2026-11-26
`steamapp` (the default, no login given to Liascape) and `subscribe` (the sign-in). What the chosen mode can't do falls to
the sign-in (under `steamapp`, when usable: the user gave that trust by signing in), then the item's Steam page; nothing
else stands in. Owner: the page needs no login and gives Liascape nothing, so it never exceeds the trust chosen. It replaced
a third mode, "Open in the Steam app", and "no mode uses another's way"; a page can't make a one-off copy, so that stays
off with why. `.claude/rules/backend/sources-steam.md`.

### Drive the Steam client through its own `steamclient.so` — 2026-11-11
`libsteam_api.so` is Valve's redistributable adapter: not ours to ship, and on Linux only SteamVR or Proton carry a
copy. A short-lived child loads the installed client's `steamclient.so` and calls ISteamUGC by vtable slot, slots read
from Valve's wrappers with objdump. `Helpers/SteamClientUgc.cs`.

### Hold the Steam app connection while the Liascape window is open — 2026-11-26
Connected, Steam shows "Playing Wallpaper Engine": a connection per download blinked it, each a friends' popup, and holding
it only while Browse showed the Workshop (what this replaced) blinked it again as the user moved between tabs. One for the
backend's lifetime would show the user in-game all day, block the real Wallpaper Engine and pause Steam's other downloads.
It starts at the first Steam-app operation (never for the window alone), stays while the window's page beats (every 5 s),
and ends three beats (15 s) after the last beat or operation: enough for a reload or a renderer recovery, not a long tail.
A running favourites watch keeps it to the watch's end. `Helpers/SteamClientHold.cs`, `scripts/test-steam-app-hold.sh`.

### Queue the Steam pages the user must click, one at a time, advanced by Next — 2026-11-11
Opening N pages at once lost all but one (Steam shows one), and a bulk Delete from Source opened the whole subscriptions
list. The to-do opens one page and waits for Next; it never reads Steam's subscribed state (that needs a Steam-client
connection the page route avoids, and "not on disk" doesn't mean unsubscribed). The only auto-advance (the owner's
ask): a subscribe entry absent at its turn whose files then appear. `Web/SteamTodo.cs`.

### Report Workshop download phases, not a percent — 2026-11-11
Steam may reserve a staged file's full size before writing it: a size-based percent sat at an empty bar for a minute on
a large item. The poll reports phases over an indeterminate bar; only `steamapp` has Steam's real byte counts.
`Helpers/WorkshopDownloader.cs`.

### Open an unsubscribe page only for items in a Steam Workshop folder — 2026-11-11
An unsubscribe through the item's page: a `local/<id>` link is a subscription, an owned `workshop/<id>` copy (a one-off)
never one, so ids without a folder are blocked at once, no page. `WorkshopDownloader.UnsubscribeInSteamApp`.

### Offer a password sign-in beside the QR — 2026-11-11
The QR sign-in needs the Steam mobile app, so the owner chose both a password sign-in and downloads through the Steam
app with no sign-in. Nothing retries a sign-in by itself: repeated attempts extend Steam's block. `Web/SteamOps.cs`;
`.claude/rules/backend/sources-steam.md` § Sign-in.

### Keep Steam tokens in the system keyring, a 0600 file as fallback — 2026-11-11
Owner's call: settings.json is posted by the UI and read by every process, so the tokens live in `Helpers/SecretStore.cs`:
the Secret Service, else `~/.config/liascape/steam-auth.json` (0600). Keyring-only was rejected: with no Secret Service (bare
compositors) signing in wouldn't work; the file is as safe as Chromium's "basic" store.
`.claude/rules/backend/sources-steam.md` § Secrets.

### Show Favourites and In my library as sets in the filter column — 2026-11-21
Owner's call: favourites are a subset of the Workshop, so they are a three-way row beside "In my library" (group Yours,
the Library's column too), not a pill swapping Browse to Steam's favourites list (no search, two sorts). ✓ shows the set
from a cache (`Helpers/WorkshopFavorites.cs`, the library index) with local search and sorts, ✕ hides it from the
Workshop's pages; no row scans pages for its items. `views/localSet.ts`; guard probe-steam `yours:*`.
### Ask Steam for a whole library's details in one request; never cache "can't tell" as "none" — 2026-11-12
Tags and trailers are Workshop listing, not files: auto-imported items lack them. CM `GetDetails` takes 1000 ids, not 100
"to be safe": 100–1000 all came back in 574–600 ms (the web API's ~200 cap is a URL length); `QueryFiles` returns 100
whatever is asked. A failed check stores nothing (WE's offline mode caches "none" for good). `Web/LibraryFactsOps.cs`.

### Keep the Workshop in Steam's own sort orders — 2026-06-02
Only Steam's sorts are offered for the Workshop (trend + period, newest, updated, most subscribed, top rated): results
arrive page by page in Steam's order, so a client-side sort would reshuffle what infinite scroll already loaded. Only
lists held whole (the local Wallpaper Engine source, a Yours set) sort client-side.

## Library

### Play a preset as its own item over its base scene's folder — 2026-11-20
A Workshop preset is its own Library card (title, preview, favourite, crash mark, playlist entry) whose source loads its
base scene's folder with the preset's values layered on, so several presets of one scene share a playlist. Copying the
scene into each preset was ruled out: hundreds of MB each, stale when the base updates, and it fights the overrides.
`.claude/rules/backend/library.md` § Presets; guard: the adapter IT § presets, `scripts/test-presets.sh`.

### Remove only the link when a watched folder's file goes — 2026-11-18
A source gone from a watched folder takes out its item only when the library links to it; a copy stays as the user's
own. Nothing leaves while the folder is missing or empty (an unmounted drive); a source is never deleted.
`.claude/rules/backend/library.md` § Folder import and watched folders.

### Normalize video loudness with one fixed gain capped by the true peak — 2026-11-11
`g = min(target − I, −1 − TP)` (Spotify's rule): a quiet item with big peaks plays under the target rather than through a
limiter; the owner checked the worst two (~14 and ~7.5 dB under) by ear and kept it. ffmpeg's `loudnorm` at playback was
rejected: even with the measurements it falls back to dynamic mode for about a third of real videos and pumps.
`.claude/rules/backend/library.md` § Loudness.

### Set scene normalization once per play — 2026-11-06
Owner decision: a playing scene keeps its gain until its first 60 s window lands, then once more at most; later
measurements refine the stored value for the next play. Gain moving mid-play is audible.
`.claude/rules/backend/player-adapter.md` § Scenes and loudness.

### Leave file-picker scene properties uneditable — 2026-10-28
`scenetexture`, `file` and `directory` need a file picker and `usershortcut` launches a Windows app: they are listed
with a reason, not editable. `Helpers/SceneProperties.cs`.

## Settings & state

### Order card previews in two lists, not toggles — 2026-11-15
"On hover" / "Not hovered" each order video / GIF / still image; a card shows the first it has. They replaced three
toggles that couldn't say every order; Basic picks a preset. Guard: matrix `appear:previewOrder`.

### Use four settings levels, Standard by default, and never reset a hidden value — 2026-11-06
Owner's final call: Basic · Standard · Advanced · Expert, replacing the "Advanced settings" and "Show
expert options" toggles. A hidden changed value gets the "tucked away" note with Show; a bulk reset was rejected because
it also reset deliberate choices such as the player engine. `src/settingsLevel.ts`; `.claude/rules/ui/state-and-api.md`.

### Fold "Resume from last" into the playlist start setting — 2026-11-01
`ResumeFromLast` was removed: a single wallpaper always comes back at its position on boot, a playlist follows "When the
playlist starts again" (`GlobalPlaylistStart` / `PlaylistStart`, start over or resume). `Models/AppSettings.cs`.

### Use one interval field: "Switch every" or "Minimum play time" — 2026-10-28
With "Switch when video ends" off the interval is a plain timer; on, the same value is the minimum play time and
`MaxPlaySeconds` the maximum. It replaced "Wait for video to end after interval" and a separate `GlobalMinPlaySeconds`.
`.claude/rules/backend/player-adapter.md` § Rotation.

## UI

### Hide and Unsubscribe live in the sidebar, never a card menu — 2026-11-27
Right-click opens the item's sidebar, so a menu at the pointer on the same click collides with it (tried 2026-11-26,
reverted). Unsubscribe and Hide are sidebar actions in both tabs. Hide only hides: per grid (the Library by path, Browse by
page URL and source), kept in `hidden.json`, undone by the removal's Undo; each grid's filter column gets a Hidden row
(✓ shows only them, with Unhide in their sidebar), offered once something is hidden there. `scripts/test-hidden.sh`.

### Teach in place, never with a step-by-step tour — 2026-11-26
First-run help is a welcome in the empty Library's place, one dismissible tip per non-obvious thing where it is met, and
empty views that say how to fill them; no guided tour walking through the app. Guard: `--probe probe-firstrun.js`.

### Let input pass through the window's opening, never end it — 2026-11-26
The opening plays to its end while every click, key, wheel and drag reaches the page at once; no input skips it. Input
already works through it at full speed (it never takes a pointer event, a card not shown yet can be clicked or focused),
so a skip would only cut the library's arrival short. Guard: probe-intro intro:click, intro:key, intro:scroll
(`components/Intro.tsx`).

### A lone video always loops — 2026-11-14
No "Loop videos" switch: play-once-and-freeze is too niche for a global setting that freezes every other video.
Every player path loops a lone video; there is no `Loop` setting.

### Left click does the tab's main action, right click opens the item sidebar — 2026-11-14
A plain click applies in the Library, opens the item to look over in Browse (double-click, Enter or the hover button
downloads and applies; a library item's card has no button). A right-click opens the sidebar everywhere, applies nothing, keeps
the selection; no item menus (§ "Hide and Unsubscribe live in the sidebar, never a card menu"). Ctrl / Shift-click only
select. An open Library sidebar follows a click. `.claude/rules/ui/design.md` § Interaction rules (its guards).

### Fade, never move, with motion off — 2026-11-12
"Smooth window animations" off and `prefers-reduced-motion` mean nothing moves and what appears, leaves or swaps
cross-fades in place on opacity alone, in 120 ms — not "every change is instant": the setting serves people sensitive to
motion and people saving its cost; an opacity fade moves nothing and runs on the compositor, while an instant change makes
panels and menus pop. Enforced: `.claude/rules/ui/design.md` § Motion off; the motion-off probe cells.

### Let a hidden gif preview keep its own clock; hold its frame only as a video — 2026-11-18
A gif preview out of sight stays mounted, hidden and undecoded, and comes back where Chromium's clock for it is, never
at frame 0. Holding its frame on a canvas needs our own ImageDecoder player (40 gifs: twice the renderer CPU, ~400 MB
more); a frozen screenshot was dropped. Only "Play GIF previews as videos" (off by default) holds it: the gif plays as
its clip, paused while the window is inactive. Guard: matrix `appear:gifResume`, `appear:gifVideo`;
`.claude/rules/ui/design.md` § Performance.

### Play every on-screen video preview, each as a small clip — 2026-11-18
Every on-screen video preview plays a backend-made clip (`Web/ClipStore.cs`), never the wallpaper's file (it holds a
connection). Owner's terms: no storage options; one clip per item, box × dpr × "Video preview quality", up
to 5 min; re-made wider, shrunk when 2× too wide while idle. Each card's still, gif and clip is made ahead of it on the
same worker and line, never a second queue; it waits while the PC is busy, not for a maximized window. Guard:
`scripts/test-clip-sweep.sh`, `scripts/test-preview-backfill.sh`, matrix `clip:*`.
### Keep the Library page mounted across tab switches; don't virtualise the grid — 2026-11-12
The Library page and the playlist bar stay mounted once shown (React `<Activity>`, hidden = display none); Browse and
Settings rebuild on each visit. Not a virtualised grid: `content-visibility` already skips off-screen cards, the cost
was the rebuild plus whole-page restyles, and windowing breaks keyboard reveal, box selection, locate-playing and probes
that find off-screen cards. Guard: probe-layout `tabs:keep`, `perf:tabs`; `.claude/rules/ui/design.md` § Performance.

### Make the UI itself a work of art — 2026-11-12
An interface people would open just to interact with: every control designed, not defaulted (springy motion, icons
acting out their meaning, a response before the click); "correct and consistent" is the floor. Every effect still follows
the motion / glow / translucency toggles and the frame budget. Checklist: `.claude/rules/ui/design.md`.

### Show tooltips only for what can't be seen — 2026-11-11
Owner: "the tooltips everywhere is really annoying and redundant, not everything needs a tooltip".
`.claude/rules/ui/design.md` § Interaction rules.

### Show focus rings only while tabbing — 2026-11-11
Owner: "we never want those pesky yellow outlines anywhere". Chromium shows its system-colour ring after any key press,
even on a clicked button; `.kbd-nav` limits the ring to Tab navigation. `hooks/focusRing.ts`.

### Make the sidebar's picture the Play control — 2026-11-11
The Play / In-playlist row was "redundant clutter": the picture is an invisible button (no Play icon, a hover scale), a
playing item gets a green frame instead of a "Playing now" pill, and the playlist checkbox lives on the card and the bar
only. `components/SidePanel.tsx`.

### Open previews on the gif or still, never the video, and remember the pick per sidebar — 2026-11-11
Owner: "dont force mp4 when the preview is a still image". The pick is per sidebar, not shared: Browse items rarely have
a video, so a shared "Video" pick would mean nothing there. The frame takes the shown preview's aspect, chosen over
letterboxing or a cover crop. `components/sidePreview.ts`.

### Loop trailers on the player's "ended", not YouTube's `loop=1` — 2026-11-11
YouTube's `loop=1&playlist=<id>` restarted early; `seekTo(0)` + `playVideo` on "ended" fires at the content's end.
`components/YouTubeEmbed.tsx`.

### Filter the Library and the local Wallpaper Engine folder in the page — 2026-11-12
Owner's call: the Workshop's column and semantics (`WorkshopTags.Build`), matched in the page against each item's saved
Steam tags, else its project.json's genres, rating and features. Each list keeps its own filter (a shared one would
empty a local list with tags it can't know); a local column offers only tags some item has. Not a backend `/library`
filter: the page holds every item and a request per click is slower.
`components/workshopFilter.ts` `localMatcher`; guard probe-filters `lib:*`, `local:weFolder`.
### Filter the Workshop in a column of three-way switches — 2026-11-11
The owner picked Wallpaper Engine's filter column over dropdowns and chips. Each tag is include / off / hide; clicking
the name toggles include only, so hiding is deliberate (✕ or right-click). `components/WorkshopFilterColumn.tsx`.
Placement (owner's pick): on the right, one panel at a time with the item sidebar and in its shape, toggled by the left
half of the split sort button (`components/SortFilterButton.tsx`); a left column, a top-bar pill, an edge handle and a
sticky row were rejected. Guard probe-filters `split:*`, `panel:*`, `swap:*`.
### Keep the playlist bar's items 112 px tall at every Thumbnail shape; the dock aims at a fixed rise — 2026-11-12
The width follows the shape (Widescreen ≈ 199 × 112) rather than a fixed 112 px width: widescreen items were too small
and the bar's height changed with the setting. The dock rises a fixed 12 px (not a fixed 1.16×, which on 112 px items
needs a header gap the owner found too big), and its bell is measured in item pitches so it parts the same at both.
`hooks/useDockLift.ts`; guard probe-plbar `bar:shape`, `bar:shapes`, `bar:headroom`.

### Bounce the playlist bar's dock only when entering, stopping or leaving — 2026-11-11
Items magnify by pointer distance; a bounce on every item during a sweep feels stuttery, so sweeping is
critically damped and only entry, stop and leave overshoot. `hooks/useDockLift.ts`; guard probe-plbar `bar:bounce`.

### Travel to the playing wallpaper once per session, spotlit in the playing green — 2026-11-10
The first Library / playlist-bar view of an app session jumps the playing item to mid-view; never again that session,
so a later switch never moves the user's scroll ("Go to playing" is the on-demand way). The spotlight uses `--success`,
the colour the playing item already pulses, not the accent. `hooks/travelToPlaying.ts`.

### Replace the card settings and preview modals with an item sidebar — 2026-11-10
The owner asked for a Wallpaper Engine-style sidebar on focus, holding the right-click menu's options, in Library and
Browse. `.claude/rules/ui/design.md` § Item sidebar; `components/SidePanel.tsx`.

### Default NVIDIA to hardware GL through ANGLE on EGL — 2026-10-28
SwiftShader cost CPU on every frame; Chromium's native-Wayland path wants Vulkan for the surface and XWayland crashed the
GPU process, while `--use-angle=gles-egl` ran stable in the owner's session. `LIASCAPE_SOFTGL=1` brings SwiftShader
back. `app/shell/main.js`; `.claude/rules/ui/shell-and-probes.md` § Shell.

### Let numeric fields be emptied while focused — 2026-10-28
Owner: "everything should let you empty out the field entirely and only snap back to minimum when you focus out".
`components/NumInput.tsx`; `.claude/rules/ui/design.md` § Interaction rules.

### Use the app's own dropdown, never a native `<select>` — 2026-06-24
Native selects can't be themed, made translucent or smooth-scrolled on Chromium/Linux. `components/Select.tsx`.

### Never blur behind panels (`backdrop-filter`) — 2026-06-24
`backdrop-filter: blur` went for its paint cost and at the owner's request; translucency is `--tr` / `--tr-strong`.
`.claude/rules/ui/design.md` § Performance.

### Build the UI in Electron + React — 2026-06-24
A bake-off measured Electron at display refresh (135–240 fps on a dense animated grid) and the frameworks tied on
performance, so React won for framer-motion's ceiling.

## Player (`liascape-player`)

### Skip only non-reference frames at a fast speed, only once mpv falls behind — 2026-11-26
A video too heavy for its decoder at `speed` > 1 sets `vd-lavc-skipframe=nonref` (`sources/frame_skip.rs`). Measured
on a 4K120 ~105 Mbps H.264 clip at 2×: `framedrop=decoder+vo` gave 42 uneven frames/s; `framedrop=no` 190 frames/s
but at 1.58× and drifting from the audio; `bidir` skips referenced B-frames too, so a P-frame decoded from one
breaks. Skipping by a speed or frame-rate threshold alone would halve fast clips the decoder handles.

### Make liascape-player the only engine, no fallback — 2026-11-22
Owner: "even with issues, it's better than the previous engine". A missing player binary is an error with its reason
(`/apply`, `/player-engine`, the health summary) and plays once it appears, never a fall back to legacy; a regression
is a bug to fix, not a reason to bring legacy back. Guard: `scripts/test-player-binary.sh`.

### Keep the pointer's arrival jump, not WE's first-frame corner stroke — 2026-11-20
WE starts the last pointer at 0 0, so its first frame strokes cursor effects from the top-left corner; ours jumps.
Kept by the owner: a WE quirk. `scene_fps_quirks.py` cancels it with a parked pointer.

### Decode scene video textures with FFmpeg, not mpv — 2026-11-20
Owner's call, over an mpv patch only the flake could ship: FFmpeg's `primary_ctx` (stock everywhere) gives a scene's
videos one CUDA context on every install; the player keeps mpv. Not: a libcuda shim, copy decoding.

### Scene fonts come from fontconfig, not a Windows install — 2026-11-18
Owner's call: `systemfont_consolas` asks fontconfig for Consolas like any app.
Microsoft's fonts pass on only inside their installers (Consolas, Segoe UI never): nothing ships or reads them from a
Windows partition. `docs/player/modules/scene-lwe-core.md` § Fonts.

### Keep a spare scene worker while scenes play or are in the rotation — 2026-11-18
Owner's call: an idle worker's ~60 MiB PSS is worth 65–135 ms off each scene apply; a rotation
without scenes reaps it at once (video-only users pay nothing). `docs/player/modules/scene-worker.md` § The spare worker.

### Run one scene worker per scene source, not per output — ~2026-10-27
Owner's call: one worker halves GPU time and VRAM and keeps the animation in sync across monitors. Per-output frame rate
is a present gate, not a second worker. `docs/player/modules/scene-worker.md`.

### Default `scene_fps` to WE's own `fps` (15), not capped by the refresh rate — 2026-10-27
Owner's call, decoded from Wallpaper Engine's frame limiter: scenes run at their author's rate, not the monitor's.

### A scene's minimum play time beats its maximum — ~2026-11
Owner's call. A maximum below the minimum (it would always win for a video) is raised to it on save, never refused.
`.claude/rules/backend/player-adapter.md` § Rotation.

### Count a GPU context loss as a crash restart, through the same budget — 2026-10-28
Even an innocent reset: the protocol carries no reset kind, so a separate allowance could loop forever.
`docs/player/modules/scene-crash-policy.md`.

### Spawn scene workers on the loop with `posix_spawn` — 2026-10-27
Not from a spawn thread: the pid would arrive late for every kill and reap path. A fence-waiting `Frame` thread was tried
and dropped. `posix_spawn` (`clone(CLONE_VM|CLONE_VFORK)`), never `fork`, so the player's memory is never copied. `src/player/src/worker/mod.rs`.

### Lower only the scene worker's GL context priority, never a load's CPU priority — ~2026-10-27
`High` on the compositor's own contexts was indistinguishable from load. `nice` / `SCHED_IDLE` stretched a
load 10× under contention: the player waits up to 50 s while the worker says `loading` instead.

### Default `__NV_DISABLE_EXPLICIT_SYNC=1` and drain libwayland's default queue every iteration — 2026-10-25
egl-wayland2 ≤ 1.0.2 leaks one `wl_closure` per present otherwise. Cost: loop p99 ≈ 1.6 ms. A value the caller set wins.
`src/player/src/wl.rs` `apply_driver_env`.

### Decode loop-rendered sources in copy modes only — 2026-10-25
Zero-copy hwdec only on render-worker lanes (three lanes with an interop); `vulkan` / `vdpau` / `amf` stay copy. mpv's own
interop and its `auto` order cost 65–320 ms per switch on the loop. `docs/player/modules/sources.md`.

### Fix glibc's mmap threshold at 128 KiB and trim after each reaper batch — 2026-10-25
Keeps freed decoder buffers from pinning RSS. `M_ARENA_MAX` was rejected: nothing measurable, more lock contention.
`src/player/src/mem.rs` `MMAP_THRESHOLD`.

### Keep the animator tick timer running while every output is idle — ~2026-10-25
About 23 µs per tick. Stopping it would mean every start, phase, step and stop path re-arming it, and a missed one freezes
an animation. `docs/player/modules/runtime.md`.

## Build & distribution

### Make the user command a shell launcher, not the C# binary — 2026-10-28
The GUI and `liascape ctl` need neither .NET's startup nor its runtime, and one relocatable script serves `install.sh`,
the AppImage and the flake. `scripts/liascape`; `.claude/rules/build-and-packaging.md`.
