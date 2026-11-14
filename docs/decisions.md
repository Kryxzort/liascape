# Decisions

Choices that ruled out a tempting alternative, so nobody "fixes" them back. Format and when to add one:
`.claude/rules/writing-rules.md` § `docs/decisions.md`. The story behind each is in its commit (`git log -S`).

## Backend/API

### Run the agent window in a private compositor, not an output of the session's Hyprland — 2026-11-12
Agents drive their own Liascape window (`scripts/agent-window.sh`) inside a headless gamescope (no seat, no input, no DRM,
sandboxed in bwrap with its own network namespace), never a headless output added to the owner's Hyprland: removing an
output always warps the cursor to another monitor's centre and focuses it (`CMonitor::onDisconnect`, a forced warp that
`cursor:no_warps` doesn't stop), and an output that stays is a workspace the owner's keys can land on. The script only
reads Hyprland; its watcher aborts on any owner-side event. Rule: `.claude/rules/ui/shell-and-probes.md`.

### Serve media from a second listener — 2026-11-12
Chromium opens 6 HTTP/1.1 connections per origin; slow `/img` `/media` `/clip` `/anim` `/still` loads held all six and
every API call (a search, a reload) queued behind them. Media gets its own listener at the API's port + 1
(`ApiSecurity.PickPorts`): its own origin and pool, answering only token-carrying GETs of the media routes; the page derives
it from the API's port (`api/client.ts` `MEDIA`). Rejected: `localhost:<port>` on the same listener (Chromium tries `[::1]`
first, where another local user could listen and collect the token; `localhost` is already the API's own origin), HTTP/2
(browsers need TLS), a discovered random port (races the first thumbnails). `.claude/rules/backend/api.md`; matrix
`browse:mediaPool`.

### Authenticate media URLs with `?token=`, not a cookie — 2026-11-11
Every page in the user's browser and every local user can reach `127.0.0.1`, so the API needs a capability only the
app's page holds. `<img>`/`<video>` src and the WebSocket can't send headers, so GET/HEAD may carry `?token=`; writes need
the header. A cookie was rejected: it is ambient, sent with any request another page triggers (CSRF again).
Enforced in `Web/ApiSecurity.cs`; `.claude/rules/backend/api.md` § Security.

### Admit the Vite dev origin only while the backend serves no UI — 2026-11-11
The dev UI on :5173 is a foreign origin; it is allowed only when `LIASCAPE_UI_DIR` is unset (`dotnet watch -- serve`),
never in production. Vite's dev-only `/__liascape/token` answers only a `Sec-Fetch-Site: same-origin` request (set by the
browser, not forgeable by another site), and the served HTML never contains the token. `app/ui/vite.config.ts`.

### Run the `SteamCmdPath` setting as a program, by design — 2026-11-11
A setting that names an executable is a code-execution path. It stays (users point it at their own steamcmd) and is
protected by the API token like every other write, not by an allow-list. Every other spawn passes an argument list.

### Report a missing dependency with a warning, never hide the control — 2026-10-28
Owner: "make missing libraries fail loudly". `/health/features` lists each dependency that silently degrades a feature and
the UI puts a `WarnIcon` on the affected rows, which stay usable. `wl-copy`, `grim` and `mpvpaper` are left out on
purpose: the UI copies with `navigator.clipboard`, the other two are legacy only. `.claude/rules/backend/api.md` § Feature health.

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

## Steam & sources

### Keep the 0600 file fallback for the Steam sign-in — 2026-11-11
The tokens go to the system keyring (Secret Service); without one they go to `~/.config/liascape/steam-auth.json`
(0600), never settings.json. Keyring-only was rejected: on a desktop with no Secret Service (bare compositors, no
gnome-keyring/KWallet) signing in would simply not work. The file is as safe as any 0600 file in the home directory:
Discord and Chromium-based apps do the same with their "basic" store. `.claude/rules/backend/sources-steam.md` § Secrets.

### Browse the Workshop over Steam's client protocol, anonymously — 2026-11-11
Scraping steamcommunity.com's browse page (30 items a page, AND-only tags, a page read per detail for the trailer) trips
Steam's per-IP limit, which locks the user's browser out for 30+ min too. `PublishedFile.QueryFiles` gives 100 items a
page with tags, previews and descriptions; the page scraper is the fallback only. One shared session, not one per call:
connect + logon (1.2–2.6 s) costs more than a page (0.5–1.3 s). `Helpers/SteamAnonymous.cs`, `.claude/rules/backend/sources-steam.md`.

### Gate every steamcommunity.com request app-wide — 2026-11-11
Owner: "make sure you obey the rate limits so user dont face ip issues". One gate spaces request starts and turns a 429
into a cooldown persisted across restarts, so no code path can burst on its own. `Helpers/SteamGate.cs`;
`.claude/rules/backend/sources-steam.md` § Steam Community rate limits.

### AND Workshop features, OR genres, each switchable — 2026-11-11
Feature tags stack on one item and Steam's own page ANDs them; an item usually has one genre, so AND would find almost
nothing. The owner asked for an all/any switch on both ("what if a user wants 3D OR HDR"); defaults are features all,
genres any. `Helpers/WorkshopTags.cs` `Build`.

### Drop untagged items under any age filter — 2026-11-11
Owner: "a 'everyone' user encountering a untagged 'mature' is a tragedy". Any age include or exclude becomes a taggroup
of the allowed ages, which drops the few hundred items with no age tag; other groups' excludes keep untagged items.
`WorkshopTags.Build`.

### Offer four Workshop download modes, the user's choice — 2026-11-11
`steamapp`, `steampage`, `subscribe` (default) and `steamcmd`. Owner: "should have 4 options not 3, the 4th being the one
which opens the wallpaper in your app" — it replaced an automatic scheme where opening the page was only the sign-in's
silent fallback. A mode never changes method on its own; the to-do's "Let the Steam app do all N" is the one explicit
switch. `.claude/rules/backend/sources-steam.md` § Workshop downloads.

### Drive the Steam client through its own `steamclient.so` — 2026-11-11
`libsteam_api.so` is Valve's redistributable adapter: not ours to ship, and on Linux only SteamVR or Proton carry a copy
(owner: "what if other users dont got steamvr?"). A short-lived child loads the installed client's `steamclient.so` and
calls ISteamUGC by vtable slot, slots read from Valve's wrappers with objdump. `Helpers/SteamClientUgc.cs`.

### Queue the Steam pages the user must click, one at a time, advanced by Next — 2026-11-11
Opening N pages at once lost all but one (Steam shows one), and a bulk Delete from Source opened the whole subscriptions
list. The to-do opens one page and waits for Next; it never reads Steam's subscribed state (that needs a Steam-client
connection a `steampage` user may avoid, and "not on disk" doesn't mean unsubscribed). The only auto-advance (owner: "auto
detect then if its flawless"): a subscribe entry absent at its turn whose files then appear. `Web/SteamTodo.cs`.

### Report Workshop download phases, not a percent — 2026-11-11
Steam may reserve a staged file's full size before writing it, so a size-based percent sat at an empty bar for a minute
on a large item. The poll reports "Steam is downloading it…" / "Steam is finishing…" over an indeterminate bar; only
`steamapp` has Steam's real byte counts. `Helpers/WorkshopDownloader.cs`.

### Open an unsubscribe page only for items in a Steam Workshop folder — 2026-11-11
The unsubscribe queue holds items deleted from the library: a `local/<id>` link is a subscription, an owned
`workshop/<id>` copy is a steamcmd download and never one. Ids without a folder are blocked at once, no page.
`WorkshopDownloader.UnsubscribeInSteamApp`; `.claude/rules/backend/sources-steam.md` § Workshop downloads.

### Offer a password sign-in beside the QR — 2026-11-11
Owner: "is it a dead end for users without mobile guard?" The QR sign-in needs the Steam mobile app; he chose both a
password sign-in and downloads through the Steam app with no sign-in. Nothing retries a sign-in by itself: repeated
attempts extend Steam's block. `Web/SteamOps.cs`; `.claude/rules/backend/sources-steam.md` § Sign-in.

### Keep Steam tokens in the system keyring, a 0600 file as fallback — 2026-11-11
Owner: "steam token is kept in plaintext??" → "system keyring and then fallback to some file other than settings.json".
settings.json is posted by the UI and read by every process, so the tokens moved to `Helpers/SecretStore.cs`; a denied
keyring means signed out for 10 min, never a prompt loop. `.claude/rules/backend/sources-steam.md` § Secrets.

### Ask Steam for a whole library's details in one request; never cache "can't tell" as "none" — 2026-11-12
Tags and trailers are Workshop listing, not files: auto-imported items lack them. CM `GetDetails` takes 1000 ids, not 100
"to be safe": 100–1000 all came back in 574–600 ms (the web API's ~200 cap is a URL length); `QueryFiles` returns 100
whatever is asked. A failed check stores nothing (WE's offline mode caches "none" for good). `Web/LibraryFactsOps.cs`.

### Keep the Workshop in Steam's own sort orders — 2026-06-02
Only Steam's sorts are offered for the Workshop (trend + period, newest, updated, most subscribed, top rated): results
arrive page by page in Steam's order, so a client-side sort would reshuffle what infinite scroll already loaded. Only
the local Wallpaper Engine source sorts client-side.

## Library

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

### Drop removed settings without migration code — 2026-10-28
A removed setting's key loads as an unknown one and disappears on the next save; the owner's own files were converted
once by a script. `AppSettings` carries no legacy branches. `.claude/rules/backend/state-files.md` § Writing.

## Settings & state

### Use four settings levels, Standard by default, and never reset a hidden value — 2026-11-06
Owner: "the forever final 4 levels" — Basic · Standard · Advanced · Expert, replacing the "Advanced settings" and "Show
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

### A lone video always loops — 2026-11-14
No "Loop videos" switch: play-once-and-freeze is too niche for a global setting that freezes every other video.
Every player path loops a lone video; there is no `Loop` setting.

### Left click does the tab's main action, right click opens the item sidebar — 2026-11-14
A plain click applies in the Library, opens the item to look over in Browse (double-click, Enter or the hover button
downloads and applies; a library item's card has no button). A right-click opens the sidebar everywhere, applies nothing, keeps
the selection; no item menus. Ctrl / Shift-click only select. An open Library sidebar follows a click.
`.claude/rules/ui/design.md` § Interaction rules; probe-select `*:plainClick`, `modClick`, `rightClickSel`.

### Fade, never move, with motion off — 2026-11-12
"Smooth window animations" off and `prefers-reduced-motion` mean nothing moves and what appears, leaves or swaps
cross-fades in place on opacity alone, in 120 ms — not "every change is instant": the setting serves people sensitive to
motion and people saving its cost; an opacity fade moves nothing and runs on the compositor, while an instant change
makes panels and menus pop. Hover holds and pointer feedback just stay still; highlights and carets change at once; loops
stand still but the spinner. Enforced: `.claude/rules/ui/design.md` § Motion off; the motion-off probe cells
(`app/shell/motion-off.js`).

### Let a hidden gif preview keep its own clock; don't resume it on a canvas — 2026-11-12
A gif preview that goes out of sight (hover ended, scrolled away, window inactive, another tab) stays mounted, hidden and
undecoded, and shows again at the frame Chromium's clock for it is on, as if it had played meanwhile; never from frame 0.
Resuming at the exact frame it stopped on needs our own ImageDecoder-to-canvas player: 40 gifs cost about twice the
renderer CPU of Chromium's gif animation (67–74 % vs 35 % of a core), ~400 MB more, and 22 % of the main thread when drawn
there. Guard: matrix `appear:gifResume`; `.claude/rules/ui/design.md` § Performance.

### Play every on-screen video preview, each as a small clip — 2026-11-12
"Animate wallpapers without a GIF" has no cap (it was 4): every video preview on screen plays a clip the backend makes
(`/clip`, `Web/ClipStore.cs`), never the wallpaper's own file — a full-size `<video>` keeps one of Chromium's 6
connections while it plays (uncapped, 12 of 24 never loaded). Owner's terms: no storage options; one clip per item, as
wide as its widest card needs (box × dpr × "Video preview quality", source shape, the card crops it), up to 5 min (a 10 s
stand-in first), kept while the item is in the library; re-made for a wider box, shrunk when 2× too wide in idle time.
The whole library follows the quality, down too (Low = disk and decode savings), once it settles (4 s) and Settings is
left, not only cards as they show. A hover hands over to the real file and back at the same moment, as every clip swap does
(`components/PreviewPlayer.tsx`), never at a loop boundary. Guard: matrix `appear:videoThumbs`, `clip:*`;
`scripts/test-clip-sweep.sh`.

### Keep the Library page mounted across tab switches; don't virtualise the grid — 2026-11-12
The Library page and the playlist bar stay mounted once shown (React `<Activity>`, hidden = display none); Browse and
Settings rebuild on each visit. Not a virtualised grid: `content-visibility` already skips off-screen cards, the cost
was the rebuild plus whole-page restyles, and windowing breaks keyboard reveal, box selection, locate-playing and probes
that find off-screen cards. Guard: probe-layout `tabs:keep`, `perf:tabs`; `.claude/rules/ui/design.md` § Performance.

### Make the UI itself a work of art — 2026-11-12
The goal is an interface people would open just to interact with. Every control is designed, not defaulted: motion has
physics (springs, overshoot that settles), icons act out their meaning, the cursor gets a response before the click, and
nothing is the browser's stock look. "Correct and consistent" is the floor, not the bar. Every effect still follows the
motion / glow / translucency toggles and the frame budget (`.claude/rules/testing.md`). Checklist: `.claude/rules/ui/design.md`.

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
Owner: "make it so we can filter on library and wallpaper engine local too, cuz why not". The same column, toggle, chips and
semantics as the Workshop's (`WorkshopTags.Build`), matched in the page against what each item knows: its saved Steam tags,
else its project.json's genres, age rating and declared features, read at library load (cached by write time), never
written to the index (Steam updates the file under a `local/<id>` link; old index files need nothing). Each list keeps its
own filter: one shared with the Workshop would silently empty a local list with tags it can't know. A local column offers
only the tags some item has (a project.json never states a resolution, nor most features), not Steam's whole list.
Not a backend `/library` filter: the page already holds every item, and a request per click is slower than the match.
`components/workshopFilter.ts` `localMatcher`; guard probe-filters `lib:*`, `local:weFolder`.

### Filter the Workshop in a column of three-way switches — 2026-11-11
The owner picked Wallpaper Engine's filter column over dropdowns and chips. Each tag is include / off / hide;
clicking the name toggles include only (a cycle through hide surprised users), so hiding is always deliberate (✕ or
right-click). `components/WorkshopFilterColumn.tsx`.
Placement (the owner's pick from live mockups): on the right, one panel at a time with the item sidebar and in its shape
(width, 900 px dock, slide: a swap moves no card), toggled by the left half of the top bar's split sort button
(`components/SortFilterButton.tsx`). Rejected: a left column under a "Filters · N" pill above the grid (it scrolled away),
that pill in the top bar (it wrapped it), an edge handle (it cost grid width), a sticky row. Guard
probe-filters `split:*`, `panel:*`, `swap:*`.

### Keep the playlist bar's items 112 px tall at every Thumbnail shape; the dock aims at a fixed rise — 2026-11-12
The width follows the shape (Widescreen ≈ 199 × 112) rather than a fixed 112 px width: widescreen items were "too small"
and the bar's height changed with the setting. The dock rises a fixed 12 px (not a fixed 1.16×, which on 112 px items
needs a header gap the owner found "too much"), and its bell is measured in item pitches so it parts the same at both.
`hooks/useDockLift.ts`; guard probe-plbar `bar:shape`, `bar:shapes`, `bar:headroom`.

### Bounce the playlist bar's dock only when entering, stopping or leaving — 2026-11-11
Items magnify by pointer distance; a bounce on every item during a sweep "feels stuttery" (owner), so sweeping is
critically damped and only entry, stop and leave overshoot. `hooks/useDockLift.ts`; guard probe-plbar `bar:bounce`.

### Travel to the playing wallpaper once per session, spotlit in the playing green — 2026-11-10
The first Library / playlist-bar view of an app session jumps the playing item to mid-view; never again that session,
so a later switch never moves the user's scroll ("Go to playing" is the on-demand way). The spotlight uses `--success`,
the colour the playing item already pulses, not the accent. `hooks/travelToPlaying.ts`.

### Replace the card settings and preview modals with an item sidebar — 2026-11-10
The owner asked for a Wallpaper Engine-style sidebar on focus, holding the right-click menu's options, in Library and
Browse. Spec: `docs/superpowers/specs/2026-11-10-we-sidebar-design.md`. `components/SidePanel.tsx`.

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
`backdrop-filter: blur` was removed for its paint cost and at the owner's request; translucency is `--tr` / `--tr-strong`.
`.claude/rules/ui/design.md` § Performance.

### Build the UI in Electron + React — 2026-06-24
A bake-off measured Electron at display refresh (135–240 fps on a dense animated grid) and the frameworks tied on
performance, so React won for framer-motion's ceiling.

## Legacy engine

### Give a one-item timed session a tick, but never rotate it — 2026-10-28
The tick is the only consumer of `pending_action.txt` and only the timer owner may switch, so a one-item session needs
one to take next / random / restart; a second consumer of the queue was rejected. `CanRotate` (> 1 item) keeps it from
rotating by itself. `.claude/rules/backend/legacy-engine.md` § Timed playlist.

### Hold the audio handoff for `AUDIO_SETTLE`, not a longer `BAND_HOLD` — 2026-10-20
Each overlay speed step glitches its audio ~200–240 ms later, so mpvpaper-A is cut 300 ms after the last step.
Lengthening `BAND_HOLD` to 350 ms made the speed tracker limit-cycle and blow its 4 s budget.
`.claude/rules/backend/legacy-engine.md` § Transitions.

### Monitor auto-mute per stream with a 10 ms parec latency — 2026-10-20
`@DEFAULT_MONITOR@` hears our own audio and oscillates, so each foreign stream is monitored on its own. parec's default
buffering held the first data ~2 s; `--latency-msec=10` gets it in ~65 ms. `Helpers/AudioMonitor.cs`.

### Ramp volume in dB with equal-power curves — 2026-10-03
mpv `volume` and PulseAudio percent volumes are cubic (mpv 50 % = −18 dB, measured), so a linear percent crossfade
sagged ~17 dB mid-transition. The renderer ramps `volume-gain` (exact dB); the backend pre-distorts percents by the cube
root (`XfPct`). `.claude/rules/backend/legacy-engine.md` § Transitions.

### Launch a legacy scene's audio open, never `--silent` — 2026-07-14
The primary monitor's LWE starts at `--volume 0` when NoAudio is on, so mute toggles live; `--silent` creates no
sink-input to unmute and would need a relaunch. Secondary monitors stay `--silent`. `PlayerHelper` LWE launch.

### Crossfade scene audio in an event-driven libpulse helper — 2026-07-14
Shelling `pactl` per stream (10–40 ms) can't beat PulseAudio's default volume at stream creation and LWE's stream
re-creation: audible flashes. `liascape-audio` applies the volume in-process on every sink-input event, matching
streams by process id. `.claude/rules/backend/legacy-engine.md` § Transitions.

### Correct LWE's restored stream volume reactively — 2026-06-25
PulseAudio's stream-restore remembers LWE's single app volume, so a fade value poisons the next fresh scene launch. LWE
forces its `application.name` and PipeWire ignores `module-stream-restore.id`, so the key can't change:
`PlayerHelper.CorrectSceneVolume` holds the new scene at target for ~3 s.

### Keep both sides playing through a legacy transition — 2026-06-25
The renderer decodes A and B with libmpv (full-live), so V→V effects show live video rather than two frozen stills;
stills are the warmup fallback and the source for a scene side — LWE's `--screenshot` dump, with grim only as a
fallback because grim captures open windows. `src/native/liascape-transition`.

### Restart mpvpaper periodically for its frame-buffer leak — 2026-05-08
mpvpaper leaks ~1.3 MB/s; `RestartMpvpaperEverySeconds` (default 600, 0 = off) relaunches it, through the tick under a
timed playlist. liascape-player never runs this machinery. `.claude/rules/backend/legacy-engine.md` § Restart daemon.

### Give `DoVideoEndWait` 3 s of empty readings before it gives up — 2026-05-03
mpv reports no time remaining around a load; breaking after 500 ms switched scenes early, so the wait allows 30 polls
(3 s). `PlayerHelper.DoVideoEndWait`.

## Player (`liascape-player`)

### Run one scene worker per scene source, not per output — ~2026-10-27
Owner's call: one worker halves GPU time and VRAM and keeps the animation in sync across monitors. Per-output frame rate
is a present gate, not a second worker. `docs/player/modules/scene-worker.md`.

### Default `scene_fps` to WE's own `fps` (15), not capped by the refresh rate — 2026-10-27
Owner's call, decoded from Wallpaper Engine's frame limiter: scenes run at their author's rate, not the monitor's.

### A scene's minimum play time beats its maximum — ~2026-11
Owner's call, for scenes only. Videos and images keep "a cap beats the minimum". `docs/player/modules/transitions.md`.

### Count a GPU context loss as a crash restart, through the same budget — 2026-10-28
Even an innocent reset: the protocol carries no reset kind, so a separate allowance could loop forever.
`docs/player/modules/scene-crash-policy.md`.

### Spawn scene workers on the loop with `posix_spawn` — 2026-10-27
Not from a spawn thread: the pid would arrive late for every kill and reap path. A fence-waiting `Frame` thread was tried
and dropped. `posix_spawn` (`clone(CLONE_VM|CLONE_VFORK)`), never `fork`, so the player's memory is never copied. `src/player/src/worker/mod.rs`.

### Don't lower a slow scene load's CPU priority — ~2026-10-27
`nice` / `SCHED_IDLE` stretched a load about 10× under contention. The player waits up to 50 s while the worker says `loading` instead.

### Lower only the scene worker's GL context priority — ~2026-10-27
`High` on the compositor's own contexts was indistinguishable from load in measurements; only the worker's is lowered.

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
