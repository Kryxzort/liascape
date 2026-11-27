# liascape — TODO

Running list of things found while working that aren't done yet. Newest context first within each section.
Delete an item in the commit that does it (the commit message is the record). Product work only — the repo is public;
one person's own reminders go in their gitignored `CLAUDE.local.md` / `docs/NIGHT-NOTES.md`. Design of the player: `docs/player/architecture.md`.

## Queued (in order — the next thing to pick up)
1. [ ] (owner) Scene wallpapers load faster — the rest (`src/player/tests/onmachine/scene_load.py`, private headless
       player). Plan for the first-ever load's compiles: `docs/superpowers/48-shader-compiles-plan.md`. Done: the worker loads the project beside its EGL setup (`--preload`); the fork's texture upload context
       and the Container's remembered lookups (in the pin since `ff7cf61`); the spare worker (`player.scene_spare`, skips
       spawn → `Hello` for every apply after a run's first: warm 65–135 ms, cold 70–215 ms faster). Left: a first-ever
       load's NVIDIA compiles. 2921510865 (3.6 GB of VRAM) wasn't measured beside a busy desktop. Not worth it (tried):
       caching the units' preprocessing. Since fork patch 0133 it costs 28 ms of 3042492564's build, 21 of 3163060610's,
       9.5 of 2388299037's (`--lwe-smoke` with `WPENGINE_HEALTH=` empty: the smoke's health report skips every shader
       cache read). A shader-cache kind keyed by the unit's text, combos and filled slots, storing each include it read
       and each texture format / flags it asked and checking them again on a hit, gave byte-identical units (2,436 in 8
       scenes, also under other user properties) and cut that to 8 / 6 / 3 ms, every warm unit a hit inside the real
       worker, but apply → first frame didn't move (`scene_load.py`, interleaved, warm medians of 16: 459 → 468, 394 →
       403, 452 → 455 ms; fastest build 289 / 288, 220 / 222, 269 / 267). Likely the render thread then just waits
       longer for the texture uploads at the first frame (inferred, not measured). Worth retrying only once those stop
       being the build's tail.
2. [ ] (owner) How fast is WE on native Windows: the switches of `docs/player/reports/scene-load-we.md` (done under
       Proton) timed on the owner's Windows install (needs the owner to boot it): from WE's open of B's `project.json`
       to B's first frame and complete picture, cold / after a boot / warm. Include 3426575339, whose video textures
       crash WE under Proton. Also record each scene's GPU memory while it plays (Task Manager → Details, the
       "Dedicated GPU memory" column for `wallpaper64.exe`, or `nvidia-smi`), with 2921510865 among them (3.6 GB in
       liascape-player, the heaviest seen), to compare with the player's `vram` probe per scene. And, if convenient,
       play preset 2843309472 with its Volume up: its slot video should stay silent (the player plays a slot's video
       silent, assuming WE never plays a video texture's sound).

8. [ ] (owner) Scenes checked against real Wallpaper Engine, every feature, every scene, and as fast and lean as
       WE. Nothing about scenes counts as done until it matches WE's own frames
       (`docs/player/spikes/we-proton.md`: `scripts/dev/we-ref-capture.sh`, `scene_we_compare.sh`).
       - The harness as a gate: rerun every library scene, set a fail line per scene (masks for WE's unseeded
         randomness), look at every failing side-by-side; rerun nightly and on every new download.
       - Every row of `docs/player/spikes/we-lwe-gap-audit.md` with a real Workshop scene that uses it (a library
         scene, else Workshop items downloaded one-off into a private test corpus outside the owner's library and
         Steam subscriptions, scanned for the feature, kept if they cover a row or another test, deleted if not,
         repeated until each row has one; never committed); no hand-built scenes. Find candidates with the Workshop's
         own feature tags (Browse's Features filter: Audio responsive, HDR, 3D, Customizable, Media Integration,
         Puppet Warp, Video Texture), else a keyword search (an effect's or object's name); keep trying new items
         until one uses the feature. A feature with no scene is
         unverified, not done; each row marked pass / fail against WE with its evidence.
       - The repo's own test scene (owner 2026-11-26: "we could make them toggles"): one big scene with a user-property
         toggle per feature (puppets + IK, particles, text and clock, effects and blend modes, 3D models and lights, audio
         response, scripts, video textures …), each feature in its own region; the harness captures each toggle alone,
         all on, and the whole-frame features on / off. Small separate scenes only for what can't be toggled or affects
         the whole frame (bloom / HDR, camera, colour grading, the clock). Made in WE's own editor with our own images,
         saved with WE's captured frames as their expected output; hermetic pixel tests against those frames. Made on
         Windows: the owner starts a session there and a Claude session drives the editor. Write the spec (each toggle,
         its region, how it is captured) before that session.
       - Check LWE's logic per row against the decompiled WE; fix what differs, starting with puppets.
       - Sound a script starts: 2922240701 (every sound object `startsilent`, its radio started by a user property
         and by track clicks) against WE — the delay from the property to the first sample, track after track,
         stop, and the wallpaper's volume and auto-mute on it. The scenes with some sounds started by a click:
         2325974975, 3289734539, 3371313623.
       - The audio piece: a private PipeWire with a null sink fed a fixed track, so music-reactive scenes compare too.
       - Performance against WE as well, in the same harness: per scene, apply → first frame, steady RAM and VRAM, CPU
         and GPU time per frame, ours beside WE's; a gap is a row to fix like a wrong picture (read how WE loads,
         caches and shares textures and shaders where it beats us). Folds in item 1's remaining load work.
11. [ ] (owner) Browse feels slow: the rest, now that the card pictures wait on neither the resolver nor each other
       (`scripts/test-card-pictures.sh`, matrix `browse:gifAfterStill`).
       - Measure the owner's window again with the CDP recorder: how long a `/still` or `/anim` now waits in the browser's
         queue for a media connection (it was ~97 % of each one's time) and whether any answer still lands at 5 s.
       - Browse end to end in the agent window (`node scripts/bench-live-ui.mjs browse`: first page, next page, a search,
         back): one run to the next varies several-fold with the network (the 35 on-screen cards' pictures in 0.4–8 s),
         so repeat each side at least three times before judging a change. Candidates: the next page fetched while the
         current one shows, recent queries kept (back / a re-search instant: back asks Steam again today, 0.8–1.8 s to its
         list), "Use the Steam app" mode's queries over the already-held Steam app connection.
       - The main thread: 410 stalls ≥ 50 ms (48 s, worst 463 ms) in the owner's 170 min; the bench's Browse run has
         275–500 tasks over one frame.
       Never more requests to steamcommunity.com than now (`SteamGate`). Guard: the bench's numbers before / after, a probe
       cell per behaviour added.

13. [ ] (owner) "Text shadow" (Settings → Look & feel, `:root.text-shadow` in `index.css`) fits coloured text over a live
       wallpaper too, and leaves the playlist bar's PLAYLIST label alone.
       - Text in a state colour is excluded today (a black copy under it "reads as dirt"), so the red Unsubscribe tile
         washes out over a light wallpaper. Give that text a shadow that suits it (a softer or tinted one, not the plain
         black copy), at least for danger / warning text on tiles; judge it on a light and a dark wallpaper.
       - The playlist bar's PLAYLIST label (`.playlist-bar-label`, `PlaylistBar.tsx`), coloured text whose plain black
         shadow looks wrong, gets the same suited shadow instead of none.
       Guard: probe cells reading the computed `text-shadow` of those elements with the setting on and off, and
       screenshots over a light and a dark `bg-live` wallpaper.

19. [ ] (owner) The owner's README replaces the agent-written one: `docs/Meat bag's Readme.md` (untracked) and branch
       `readme-preview` (8 commits: collapsible install steps per distro, shorter previews, a readable Settings image, a
       required / optional "You'll need"; `docs/preview/` holds its images, untracked). Bring it up to date with today's
       app (only liascape-player, the download modes, Start with your desktop, the welcome …), keep the owner's voice and
       layout, make it `README.md`, delete the branch and the untracked copies.

20. [ ] (owner) One shared notice when Steam is limiting requests: wherever Steam data is missing because of the cooldown
       (`Helpers/SteamGate.cs`: Browse, the sidebar's comments / favourite / creator, downloads), say "Steam is limiting
       requests from this connection — back in N min" in the app's notice look, instead of the sidebar's parts going
       quiet. One source of truth for the cooldown's end (the backend's), live countdown, gone when it ends. Guard: probe
       cells with the stack's cooldown fixture for each place, and motion-off.

21. [ ] (owner) Split the biggest files so agents can work in them: `src/player/src/runtime.rs`, `app/ui/src/index.css`
       and `app/shell/probe-matrix.js` into modules / partials by area, no behaviour change (the full player suite and the
       full UI matrix green before and after, the same cell list), and trim comments that only restate the code
       (`.claude/rules/writing-rules.md` § Code comments).

22. [ ] (owner) Trim the rules to well under their caps without losing a rule an agent needs. Today `player/scenes.md` is at
       250 / 250 lines, `backend/sources-steam.md` ~28k / 30k chars, `ui/design.md` and `backend/library.md` ~21k; the
       reference docs and `docs/decisions.md` sit at their caps. Method (community guidance on CLAUDE.md / rules: a
       buried rule is a dropped rule; spend the instruction budget only on what an agent can't infer or a check can't
       enforce):
       - Per bullet: keep it if an agent would otherwise get it wrong; cut it if the code makes it obvious; when a test,
         hook or `check-rules.sh` enforces it, keep one line + the guard's name only where a "fix" would undo it.
       - Move "how it works" prose to the reference docs (`docs/player/modules/`, linked); rules keep musts / nevers.
       - Narrow the globs and split a file that serves two areas (scenes.md: core vs audio vs presets) so a task loads
         fewer bullets; merge overlapping bullets across files (one fact, one place).
       - Fold old `docs/decisions.md` entries the code no longer needs defending; keep each reference doc ≤ ~12k.
       - A recall check after: an agent opened on a file in each area recites that area's rules for a set task; a
         critical rule it misses moves higher, gets clearer, or becomes a hook / check.
       Target: every rule file ≤ 80 % of its line and char caps. `check-rules.sh` green; no guard citation lost.

23. [ ] (owner) Clean up `docs/TODO.md` (106 KB, much of it backlog written before the switch-over): check every
       backlog item against the code, delete what is done or obsolete (the legacy engine, mpvpaper, LWE-subprocess
       items), merge duplicates, and say for each kept item what is still missing. Report what was cut and why.

25. [ ] (owner's night of choice, real session) Rerun `src/player/tests/onmachine/scenes.sh crash` on a quiet
       machine. The 2026-11-27 run (43/52) overlapped agents' hermetic suites; it now takes the test lock, so none can.
       It must show: DP-1's tone with 0 drops in every event AND in every quiet window (the new "quiet windows (no
       event)" check — drops there are the machine's, not a worker's); DP-1's pacing within its quiet windows; DP-2
       holding its frame (the first grim now waits for a killed worker's reap: the failing pair was the dying worker's
       own last frame, markers 2013 → 2014, latching after the first grim). Hermetically nothing couples:
       `tests/api.rs` `a_scene_workers_crash_never_drops_another_outputs_tone` (private PipeWire, a video's tone on one
       output, a soundless and a sounding synthetic scene killed and hung on the other) saw 0 drops and no lost bus
       cycle in 36 events over six runs, idle and under 24 / 48 busy threads, pacing never missed, loop busy ≤ 6.2 ms;
       in the real run two of the three failing events were a soundless scene (no worker stream on the bus) with the
       loop ≤ 2.6 ms busy. A drop or slip that still shows on a quiet machine with clean quiet windows is a real coupling outside
       these (the GPU: a worker's EGL context going and coming on the real outputs): chase it then.

26. [ ] (owner) Pick the sidebar's presets row look: A (built: the creator row's look, "Made for this scene", a
       sliding chevron), B (three fanned preset thumbnails leading, "2 presets made for this scene") or C (an accent
       left edge, a tinted glyph and a count pill). Mock-up screenshots: the night notes of 2026-11-27.

27. [ ] A looping video's sound loses one graph quantum (64 samples of exact silence, 1.3 ms at 48 kHz) at every
       loop wrap: the private sink's recording in `a_scene_workers_crash_never_drops_another_outputs_tone`'s first
       version (a 10 s clip) had one at 10.16 s and 20.16 s and nowhere else; plain mpv 0.41 (`--loop-file=inf
       --keep-open=yes`) does the same (65 samples per wrap, 3 s and 4 s 240 fps clips). Judge it on real content
       (an audible click on a tone; music likely hides it) and close it if mpv offers a gapless wrap.

28. [ ] probe-sidebar `lib:reflow` fails when run alone (`--only '^lib:reflow$'`), on lp-player as well as with the new
       sidebar motion, and passes inside the whole probe: at 1000×560 with Large cards and 24 extra items the right-click
       opens the sidebar but the grid keeps 5 columns ("the cell proves nothing"), so the card-stays-in-view check never
       runs. Find what the earlier cells set up that it relies on (the card size, the window) and make it stand alone.

30. [ ] The suites without a network namespace (the UI matrix, the adapter IT, the settings suites,
       `test-steam-signin.sh`, `test-steam-app-hold.sh`) guard only the backend's own connections
       (`LIASCAPE_TEST_NO_NETWORK`); Electron, ffmpeg and the player in them can still reach the real network and its
       DNS. Run them inside `scripts/test-netns.sh` too (the matrix's private Xvfb, audio server and CDP ports all live
       on loopback), or show that nothing but the guarded backend could look a name up.

## Ready-to-do backlog (owner, 2026-11-16: next after Queued; each gets a short brainstorm before it starts)
- [ ] **Packaging**: `scripts/PKGBUILD` (`liascape-git`) builds the current app through `scripts/install.sh`, with every
      download in `prepare()` and an offline `build()`. It builds clean on Arch (`makechrootpkg -c`, `electron45-bin` and
      the three AUR fonts passed with `-I`), `namcap` is clean but for accepted warnings (.NET's optional
      `liblttng-ust`, "unused" libc stubs in .NET's own libraries, run-time-only depends it can't see), and the package
      passed an install test as a throwaway user: `liascape help`, the app under a headless sway, a video (NVDEC) and a
      scene, nothing read from a build tree or a source cache. Left:
      - [ ] Publish `liascape-git` to the AUR (first drop `zlib` from its depends if still nothing links it: `namcap`
            flags it).
      - [ ] Rebuild the AppImage (`scripts/build-appimage.sh`, still bundling only Electron): build
            from install.sh's staged tree on an old glibc (an Ubuntu 22.04 container); bundle libmpv and its FFmpeg,
            libplacebo, libass, SDL2, harfbuzz/freetype, lz4, libxkbcommon and static `ffmpeg`/`ffprobe`; take glibc,
            GL/EGL/Vulkan (glvnd), libwayland, PipeWire/libpulse, libva, fontconfig and libcuda from the host; give every
            bundled `.so` an `$ORIGIN` RUNPATH rather than `LD_LIBRARY_PATH` in AppRun; pass `--no-sandbox` only when
            unprivileged user namespaces are off. Test with `ldd` on every ELF in containers without mpv/FFmpeg/SDL2.
- [ ] **Multi-monitor management** (per-monitor wallpapers, user-facing): UI assignment, per-output rotation, which
      monitor actions target, `/current` + preview per output, `--restore`, hotplug defaults. Design (top-bar screen
      carousel, follow All, per-screen popover, sound priority list): `docs/superpowers/specs/2026-11-17-multi-monitor-design.md`. (plan: `docs/superpowers/plans/2026-11-17-multi-monitor-v1.md`)
- [ ] **Web wallpapers**: WE `web` items via CEF / LWE's `webhelper`, an optional build module (the player's last phase), gated on the NVIDIA LINEAR-dmabuf external-only risk. Today WorkshopTags.Unplayable drops Web from
      Browse and the scrapers; once it plays, take it out of Unplayable and the Browse type filter (its tag then shows
      in the sidebar on its own: components/sideTags.ts hides only "Wallpaper" and the type).
      The same web player then serves Lively Wallpaper's web wallpapers (next item).
- [ ] **Lively Wallpaper wallpapers** (owner): import Lively's shared packages — a `.zip` or folder with
      `LivelyInfo.json` at its root (title, type, file name, preview) — through Import and the folder import (`Helpers/FolderScanner.cs`); no
      Browse source (Lively has no central catalogue; the look-alike "Lively" gallery sites aren't the project's).
      Video / gif / stream types play with what exists. Web type (HTML/WebGL, Lively's richest wallpapers; it has no
      scene format) needs the web player above: map `LivelyProperties.json` (slider, textbox, dropdown, colour, checkbox,
      button, label) onto the properties editor, call the page's `livelyPropertyListener`, later feed
      `livelyAudioListener` and its system data. Application type (Unity / Godot / .exe) NOT planned, as for WE.
      Lively is GPL-3.0 like us, so code may be copied (notices kept, a row in UPSTREAM.md / CREDITS.md), but only its
      LivelyInfo / LivelyProperties C# models + parsing fit (our backend is C#); its player, audio and system data are
      Windows-only (WinUI 3, CEF in a window, WASAPI). Cost: import + video types ~1–2 days, properties + JS shim small;
      the web player is the big part and is shared with WE web wallpapers. Format docs: the project's GitHub wiki (the
      project moved to lively-community/lively, run by Sketches srl).
- [ ] **More wallpaper sources** (owner: support all of them): first one source interface (search, page, details,
      download, filters/sort) that Browse, the sidebar and the download queue use, with MoeWalls / MotionBGs / DesktopHut
      moved onto it; sources switch on/off in Settings. Then add Wallhaven (stills,
      keyless) and Pexels Videos (licensed ambient loops, key). Skipped as redundant: Pixabay (≈ Pexels; only if Pexels
      proves too small), Unsplash (≈ Wallhaven's photos), Wallpaper Waifu / MyLiveWallpapers (≈ MoeWalls), Alpha Coders
      (≈ Wallhaven), Coverr (≈ Pexels). Once the interface lands, compare MoeWalls / MotionBGs / DesktopHut's top 100 for
      duplicates and drop one that adds little. Keyed APIs take the user's own free key (never one in the repo);
      credit the creator where the API asks (Pexels); a source that stops answering says so.
      UI (owner's idea): ONE Browse view, no source pills — a Sources section heads the filter column: a checkbox per
      enabled source with its result count (click a name to show only it), 🔑 = needs a key (links to Settings). Results
      from the checked sources merge into one grid, each card badged with its source; each source streams in on its own
      (a slow or failing one never blocks the grid; it shows a warning by its checkbox). Search + type filter apply to
      all; source-only filters (Workshop tags / rating, Wallhaven colours…) sit in a section titled with the source,
      shown while it's checked. Sort: Newest merges by date; Popular interleaves, each source keeping its own ranking.
      Defaults: only sources that work with no setup — Workshop, Wallhaven (keyless for SFW), the scraped live-wallpaper
      sites. Keyed sources (Pexels) start unchecked and ask for the free key in place when checked;
      never a key prompt on first launch. Checked 2026-11-17: Wallhaven needs no key for SFW (NSFW + account settings
      need one), 45 calls/min per caller; Pexels' free key = 200 requests/h, 20,000/month, a visible "Photos provided by
      Pexels" link required, and its limit raises may be paused — so no shared project key or proxy, each user's own.
      MyLiveWallpapers stays out: it has a ring of look-alike clone domains.
- [ ] **Quick switcher** (owner): a keybind (`liascape switcher` for the compositor to bind) opens a stylized popup of
      wallpapers to switch to — for people who don't run a timer or a playlist. Arrow keys / mouse pick, Enter applies
      (to the screen it was opened on, or All — the multi-monitor design's rules), Esc closes; works with the app
      closed, so it's a layer-shell overlay (the player or a small dedicated window), not the main Electron window.
      Brainstorm first: what it lists (recent, favourites, the playlist, search), and its look.

- [ ] **The logo in the app** (owner): the icon (`app/ui/public/favicon.svg`, Night) shown inside the UI where a logo
      belongs (the top bar or sidebar header, an About panel, the first-run / empty-library screen). Two variants exist:
      Night (the installed icon) and Lavender (the same art on a light lavender ground, `app/icon/liascape-lavender.svg`,
      both from `app/icon/generate.py`); the in-app logo follows the theme once light themes exist (Lavender on light, Night on
      dark). The installed icon stays Night: launchers cache it and Wayland takes it from the desktop entry, so it
      never switches.
- [ ] **A tray icon** (owner): a StatusNotifierItem with the controls on right-click (play / pause, next, previous,
      mute and volume, the playlist on/off and which playlist, a recent-wallpapers submenu, open Liascape, quit) and
      left-click opening the app. It must cost next to nothing while the window is closed: Electron's `Tray` keeps the
      whole Electron main process alive (100+ MB), so prefer a small native helper
      that speaks SNI + dbusmenu itself and drives the backend's API / `liascape ctl`, idle on D-Bus with no polling
      (it listens for the backend's change events), and a setting to turn it off. Its icon can follow the system's
      light / dark preference (Lavender / Night). Check how Hyprland bars (waybar, DMS, noctalia) render SNI menus
      before choosing the menu's depth.

## On a real desktop session (not hermetic)
- [ ] The engine switch-over's night runs: the crash-isolation re-run (`scenes.sh crash`, `programs.sh crash`) and the
      8 h soak (`scenes.sh soak --minutes 480`); a regression they find is a bug to fix. Frozen-onset micro-gaps
      (2–10 ms) don't count as failures unless the owner hears them.
- [ ] Compare `docs/player/reports/we-ref/compare/` side-by-sides against WE on Windows (a human's eyes are the final word).
- [ ] Decide: UI-matrix randomized runs (optional).
- [ ] The window's opening on the owner's own window (the Vite dev build, a busy start: the backend still scanning):
      the window opens on the logo, and the split / cascade plays rather than the lift; measured only in the agent
      window so far (`scripts/agent-window.sh`), where every start took the cards path before and after.

## Before the first release
- [ ] Turn compatibility back on: CLAUDE.md § Hard rules, `.claude/rules/backend/state-files.md` and
      `.claude/rules/build-and-packaging.md` say formats, settings and CLI flags may change freely only while no one
      else runs Liascape. At release: never break a CLI flag or a state-file format again (an old file must load).
- [ ] Changelog from commits: at the release tag, every commit carries a `Changelog: Added|Changed|Fixed|Removed: <one
      user-facing sentence>` trailer, or `Changelog: none` for internal work. The commit-msg hook requires it on commits
      Claude co-wrote; CLAUDE.md's commit rule and the PR template ("What this changes" repeats the commits' lines) say
      so. `CHANGELOG.md` (Keep a Changelog) is written from `git log <last tag>..HEAD --format='%(trailers:key=Changelog,valueonly)'`.
- [ ] Delete `src/backend/Helpers/LegacyTakeover.cs` (it stops a session the old mpvpaper / LWE engine left running and
      replays it on the player) and its rule line in `.claude/rules/backend/player-adapter.md` once every install that
      ran the old engine has started a build with liascape-player as the only engine.

## Upstream PRs (once the project is done)
- [ ] Draft PRs offering the LWE fork's patches upstream (Almamu/linux-wallpaperengine), several small focused ones.
      Drafts only: opening them publishes under the owner's name, so the owner approves each before it's sent.
- [ ] Optional: auto-mute flapped 6× in 16 s on 2026-11-06 (Spotify + a notification, 500 ms unmute delay) — a longer
      unmute delay stops it.

## Switch-over bar
- [ ] Seam probe at start-up, on a real session: the on-machine seam probe (`scenes.sh`) reports 0 start-up seam frames
      now that a restored layer waits for its source's `Ready` (hermetic guard: `src/player/tests/api.rs`
      `restore_waits_for_ready_no_seam`).

## UI
- [ ] Find the matrix cell that hung a shard's probe Electron for 90 min after `single × pause:appBg` (it ignored
      SIGTERM). In shard 2's order of a full 6-shard run the next cell is `single × load:duringRestart` (it SIGKILLs the
      player while the page's first `/current` and `/events` are held); 10 single-stack runs of `autoMute:unmuteDelay`,
      `pause:appBg` and `load:duringRestart` all passed, so it needs the full matrix's load. The runner now names a
      hung cell as an ERROR with its last phase and log lines: read that the next time it fires. The probe's waits
      on the backend (`http()`) and the page (`js()`) have no timeout of their own.
- [ ] The other probes (`--probe probe-sidebar.js`, `probe-steam.js`, …) and the matrix's fuzz steps have no per-cell
      limit: only the run's ceiling (5400 s for another probe) ends a hung cell there. Give their loops the heartbeat
      probe-matrix.js writes (`LIASCAPE_MATRIX_CELL_FILE`, `LIASCAPE_MATRIX_RESUME_AFTER`) so `test-ui-matrix.sh` names
      and skips the cell. Guard: a hang test cell per probe in `scripts/test-matrix-watchdog.sh`.
- [ ] Probe cells out of step with today's app: `probe-sidebar lib:preset:needsBase` / `needsBaseOff` still expect
      the base-scene button disabled while signed out (no download mode blocks a download now); `probe-steam
      ws:comment*` assume a window short enough for the comments to start below the fold (pass at 480 px, fail on a
      taller one: size the window in the cell); `probe-steam steam:sub:keepMenu` fails about one full run in two.
- [ ] An item trashed outside this page (`POST /library/trash` from another window or client) never reaches an open
      page: `AppOps.Trash` broadcasts nothing (only `library-synced` for presets it greys out), so the Library keeps
      the card and the live background (`components/WallpaperBg.tsx`) keeps a removed video until the next library
      read. Broadcast `library-synced` on a trash and an undo. Guard: probe-settings `bg:removed` with the trash posted
      by the probe instead of the Library's Delete.
- [ ] A first `/library` read that fails leaves the Library blank until a later read (`libraryRead` stays false,
      `store/index.ts`; the welcome and empty states wait on it): show an error with Retry there instead.
- [ ] probe-sidebar `lib:preset:needsBase` fails on lp-player's own UI: it expects a plain Workshop download disabled
      under "subscribe" when signed out and sent as a one-off, but since the two download modes (`actionBlocked`)
      only the one-off is blocked and a signed-out subscribe opens the item's page. Update the cell to the modes' order.
- [ ] probe-steam `ws:favoriteSteam` fails on lp-player's own UI too, alone and in the whole probe: "the pill moved or
      resized as its state landed: [182,0,53,25]" (its `Off` variant passes). probe-icons `icon:centre:filters` failed
      once in the whole probe ("button.wf-seg.e[Hide Favourites] hover: the glyph is off its chip's centre by (-2.83,
      -0.47)") and passes alone, on this tree and lp-player's: a hover read mid-motion; find what an earlier cell leaves.
- [ ] probe-filters `search:keep` fails inside the whole probe (on lp-player too) and passes alone: "840 px, room: after
      a blur holding "k1" it is folded reading "k1" (want open)". An earlier cell leaves something that takes the status
      slot's room (a wallpaper playing, the bar's width); make the cell set up its own state.
- [ ] The item sidebar's open / close glide costs main-thread frames: `node scripts/bench-live-ui.mjs sidebar` (agent
      window, Vite dev, ~147 Hz, the owner's library copy, 53 preview videos playing) went from overBudget 84 / 86 and
      over2Frames 42 / 53 before the full slide to overBudget 145 / 139 / 155 / 93 and over2Frames 62 / 49 / 86 / 68 with
      it; the `--profile typical` runs stayed within noise (58 / 67 → 75 / 67). The trace's long tasks are main frames
      while ~40 cards glide on `translate` / `scale` (`components/sideMotion.ts` playGrid): paint lifecycle + layerize
      ≈ 7 ms each and IntersectionObserver work for the moving cards (their preview visibility and `content-visibility`).
      Find what schedules a main frame per animation frame (a composited glide shouldn't need one) and cut it; measure
      before / after on the same bench, several runs each (the spread is ±30).
- [ ] Text that changes in place pops, against design.md's "content changes slide or cross-fade … numbers and bars
      ease" (only the sidebar title, `components/SideTitle.tsx`, does it). Add two shared primitives in `components/`:
      a `SwapText` (keyed on the value: the old line leaves and the new one arrives with a short slide or cross-fade,
      width morphing on the soft spring; `no-motion` = a cross-fade) and an `EaseNumber` (counts roll or ease to the new
      value; `no-motion` = instant). Then audit and convert: status lines and counts (selection, results, the
      favourites load line's "120 of 450"), the playlist bar's now-playing, sidebar facts on an item switch, setting
      values, button labels that change state. Never on text the user is typing or selecting. Guard: a probe cell per
      primitive (per-frame in-between states) plus one per converted area.
- [ ] After #114 lands: make Knip (`npx knip@5` in `app/ui`) a check — 23 unused exports today (14 values, 9 types:
      e.g. `SIDE_SLIDE_MS`, `useFilterDocked`, `presetsUsing`, `locateFx`). Per export: drop `export` when only its own
      file uses it, delete it when nothing does (a probe reading it through the page counts as a use). Then add Knip as
      a devDependency with a `knip.json` and a `scripts/check-*` hook so new dead exports fail.
- [ ] A failure recorder for the UI matrix: when a cell fails, `app/shell/cdp.js` saves the last ~20 actions (what was
      clicked / typed / waited for, with timings), the console and failed network requests since the cell began, a
      screenshot and the DOM at the failure, next to the cell's log. Today an agent re-runs a red cell with added
      logging to learn this. Cheaper than porting the probes to Playwright (27k lines, 24 files, ~850 cells) for the
      part of its trace viewer that matters; new probes may still use Playwright over CDP if it proves itself.
- [ ] UI matrix fuzz: `playlistBarDrag:lastToSecond` fails "a switch was requested" (a playlist-bar drag of the last item
      to second asks the player to switch), on lp-player as well as with the #67 change. Replay: `scripts/test-ui-matrix.sh --fuzz-replay 'pending:seq:itemSpdDrag+next:shown,itemVolReset:other,seq:plTrEffect+next,itemVolDrag:other,seq3:playlistBarRemove+trashUndo+next,playlistBarVol:off,seq5:playlistBarDrag+next+pause+resume+next,playlistBarDrag:lastToSecond'`.
      Find whether the drag really switches (a product bug) or the cell misreads a switch an earlier step queued.
- [ ] The macro feature = the rules system: triggers → actions with exceptions, run inside the player (research in
      `docs/superpowers/specs/2026-10-29-rules-recon.md`). "A game is running" is one of its first triggers, not a
      separate setting: detection notes and the cases to compose with in
      `docs/superpowers/plans/2026-10-29-game-running-signal-DRAFT.md`; what it does (pause, mute, stop) is the
      user's rule, so no default to pick up front. Scripting for advanced users is an advanced tier where users write scripts.
      Owner 2026-11-10: it should be general-purpose enough to build intricate setups that the built-in
      triggers/actions can't express (the escape hatch, not just one more action type).

## liascape-player (after design approval)
- [ ] A PipeWire restart can wedge an mpv core for good (about 1 kill in 6 under load): the audio bus reconnects but
      that player's mpv stays stuck. Found while hardening `i7_bus_reconnects_after_pipewire_restart`; unlanded work
      (probe `sources {mpv: false}` skipping the synchronous mpv reads, an `audio_device` probe field, the test
      detecting the wedge and rerunning) saved as `~/Projects/liascape-salvage/a552e4be-probe-mpv-false.diff` (base
      516c8fa9). Find why the core wedges before taking the test half.
- [x] **Advance-on-end play-time limits** (owner, 2026-10-28: "maximum minimum when end on wallpaper"): a minimum
      (a shorter clip loops and advances at the end of the loop that reaches it — never mid-loop; a still image shows
      for it) and a maximum (a longer clip, and a scene, advances once it played that long — now, with its transition),
      wall-clock seconds, 0 = off by default, global + per-playlist override, live, kept across a backend restart.
      `player-adapter.md` § Rotation (was § Play-time limits; the minimum merged into the interval field since), UI `PlayTimeInput`. Guards: IT §
      "advance-on-end play-time limits" (RED on the base backend), self-test `PlayLimitAssertions`, settings-merge,
      matrix `playlist|global:minPlay|maxPlay`, `global:maxPlay:own`.
- [x] **Rotation redesign** (owner-approved, 2026-10-28): "Switch when video ends" off → "Switch every" (a plain
      timer, unchanged); on → the SAME interval field is "Minimum play time" (play at least this long, then switch at
      the next video end; a shorter clip loops to a loop's end; an image / a scene shows this long) with "Maximum play
      time" right below (switch even mid-video). "Wait for video to end after interval" and the separate minimum are
      gone (no in-app migration — a one-off jq script converted the owner's settings / playlists / session files).
      Same in the playlist modal. `player-adapter.md` § Rotation. Guards: IT § "advance-on-end play-time limits" + scene
      + backend-restart (RED on the base backend: 26 fails incl. every new check), settings-merge (RED 6), self-test
      `PlayLimitAssertions`, matrix `plAdvanceRelabel` / `gAdvanceRelabel` / `gAdvanceOn` / `playlist|global:minPlay|maxPlay`.
  - [ ] A later task renames code identifiers to the UI labels (`IntervalSeconds` → switch-every / minimum, …).
- [ ] Health follow-ups (2 of 3 done 2026-11-02): ~~the playlist modal's Transitions field had no health icon (the global row
      has)~~ — it has the same warning icon now (`components/FeatureWarn.tsx`, `useFeatureWarnings`; probe-health cells);
      ~~the PipeWire bus being down isn't reported~~ — `hello.health.bus` → the `audio-bus` row of `/health/features` (ok /
      reason "sources play on mpv's default device" / unknown; summary only, no setting row), adapter IT + self-test +
      probe-health guard it. **Still open:** Intel GPUs have no VRAM probe at all (an Intel-specific one would make the VRAM
      rules work there).
- [ ] Remaining player phases (the web worker; the ongoing scene-compatibility programme). Roadmap:
      `docs/player/architecture.md` § Not built.
  - [ ] Pause-when-covered has only the pause action; Wallpaper Engine's "Mute" and "Stop" variants of the cover action are not built.
  - Phase 3 Programs and Signals (rotation, history, restore, pause-when-covered in the player; daemons retired): all tasks done; on-machine numbers and findings in `docs/player/reports/phase3.md`. Task 14 (in-player auto-mute): **flipped 2026-11-02** after the on-machine parity run (§ 7, owner-approved; criterion 9 read as "reasonable"): the player's Signal is on by default (`LIASCAPE_PLAYER_AUTOMUTE=0` = off), `AudioMonitor.AutoMuteParityPassed` is gone, `FeatureHealth` reports the Signal's needs. Still open: criterion 3 for a new stream under full CPU saturation (harness only, `lia-sysmon` lag, not traced); MPRIS through the backend with a Playing player and a Flatpak player untested; a player without the capability has no auto-mute with the app closed (accepted: the escape hatch / a bus-down player).
  - Phase 2 scene worker: **all tasks done**. The on-machine battery ran 2026-10-29: `docs/player/reports/phase2.md` (`src/player/tests/onmachine/scenes.sh`,
    also `battery.sh scenes`); bar the owner's VT-switch/suspend check (Waiting on owner) only the findings below
    are open.
  - **Phase 2 battery findings (Task 14, `docs/player/reports/phase2.md` § 10).** Fixed with tests: F1 scenes at
    the refresh paced by frame callbacks, F2 the dropout detector's ramp-edge bins + meter gaps (`unmeasured`), F3
    the bus meter on the RT data thread, F5a the GPU budget reads every output, F6a the source mirror writes only
    changed values. Open:
    - [ ] **F6b** (on-machine 2026-10-29, `phase2-20261029T202428/workers.json`: 4 workers mid-fade **2.45 %** per
          worker vs the 0.6 % bound — still FAIL; 2 workers steady within noise, PASS) — compositor CPU per scene worker mid-transition 2.75–4.05 %** (steady state 0.1 % after F6a):
          during an S→S fade the runtime recomputes `srcs:` / the scene demand on every sync (`Graph::get`,
          `srcs_for_connector`, `format!` of paths at the top of the profile). Cache per `picture_rev` / transition
          change. `perf`: `nix shell nixpkgs#perf -c perf record -g -p <compositor>`.
          **Root cause fixed (2026-10-29, "Cache Each Scene's Demand Per Routing Change"):** `SourceHost::sync`
          (once per worker frame) recomputed every scene's `outputs_of` — 17.7 % of the main thread mid-fade; now
          cached per `Graph::demand_rev` (2.4 %). Headless A/B (`scenes.sh transport`, 144 + 240 Hz, 4 synthetic
          workers mid-fade): excess user instructions 0.85 → 0.33 G/s, CPU 2.6 → 1.2–1.6 % per worker (headless
          CPU is ±1 %). What's left is the per-frame transport (latch, fences, the `time_pos` mirror) and the
          transition's 1 kHz gain timer. **Owner:** re-run `scenes.sh workers` on the real outputs for the 0.6 %
          bound (it can only be judged there).
          **Round 2 (2026-10-29, "Update Only The Source A Wake Was For", "Drop The Scene Transport's Idle
          Syscalls", "Stop Allocating On Every Graph Write"):** each worker frame is a loop wake (~1.5 with the fence
          wake), and every wake updated *every* source, re-synced every source, re-derived each output's routing
          from the graph, read every worker's socket/pipe + `waitpid`ed it, `eglWaitSync`ed the already-signalled
          acquire fence (~10 syscalls + an ioctl on NVIDIA) and pushed 1 kHz gain steps to soundless workers. Now a
          wake updates only its source, `sync_sources` runs only when due, routing is cached per `demand_rev`, reads
          follow epoll readiness, no wait on a signalled fence, soundless scenes only fold their gain (details
          `phase2.md` § 10 F6b round 2). Headless A/B (3 rounds each, isolated builds): mid-fade excess user+kernel
          instructions **0.40–0.42 → 0.14–0.21 G/s**, main-thread syscalls per worker frame ~56 → ~29. On the real
          outputs (`f6b-20261029/om-*`, machine loaded by another agent): mid-fade compositor instructions
          1.05 / 1.45 → 0.77 / 0.74 G/s; the CPU check **PASS 2/2** (−0.25 / −0.3 % per worker; HEAD in the same
          session 2.25 / −0.05 %) — CPU % there is noise-dominated (baselines 23–37 %). **Open:** confirm on a quiet
          machine. What's left per frame is the transport floor (`recvmsg` Frame, `sendmsg` Tick + Release, the release
          fence — NVIDIA's `eglCreateSync` + dup alone is ~12 syscalls). Next lever if needed: reuse one release fence
          for every slot not sampled since it was made (one per compose instead of one per latch, ~halves the fence
          syscalls). Tried and dropped: a worker thread that sends each `Frame` after its fence (1 compositor wake per
          frame) — no compositor gain once a wake was cheap, +2 worker context switches per frame.
    - [ ] **F1 follow-up — tick scenes from the frame callbacks / the exact refresh** instead of a rounded-Hz grid,
          so a scene at the refresh never beats against the vblank (F1 fixed the presents, not the content clock).
- [ ] **Explicit sync back on NVIDIA once egl-wayland2 > 1.0.2 ships** — Task 20e: 1.0.2 leaks one queued
      `wl_buffer.release` (~224 B) per present with explicit sync (upstream fix 6235dd8, 2026-09-09, unreleased),
      so `serve` defaults `__NV_DISABLE_EXPLICIT_SYNC=1` (cost: 240 Hz interval p95 ~4.7 → ~5.2 ms, loop tick
      p99 ~0.3 → 1.6 ms, 0 missed) and drains libwayland's default queue every iteration. With a fixed driver
      the drain alone is leak-free: drop the env default (keep the drain). `docs/player/modules/wayland.md` § Wayland NVIDIA notes.
- [ ] **Load-sensitive test flakes** (seen once each under a busy desktop, never reproduced unloaded):
      `stepped_align_end_reveal`, `bus_down_falls_back_to_default_device`, `supervise::crash_restores` (clip
      wrap under load). Watch; harden their timing margins if they recur.
      **Scene starts under IO load — a real bug + test deadlines, fixed (2026-11-16).** The "never became ready"
      family in `tests/transition.rs` (10 in one full run at load ~40) is a cold scene worker start: not CPU (16
      burners pinned with the suite: 0 failures in 3 runs) but IO — 2 fsync-ing writers + the worker's binary/libs
      evicted from the page cache every 3 s: 12 and 9 failures in 2 runs (`src1 never became ready`, B not started in
      5 s, `slow_loading_scene_b_is_waited_for` broken after 3 "hung" kills, `scene_b_load_error_keeps_a` counting a
      kill as a crash). Sampled: the worker sits in D state paging in (`filemap_fault`, 2–3 major faults/s) for 5–20+
      s before `Hello`, and its first render can miss pings the same way. The host killed it at `HELLO_TIMEOUT` (5 s)
      / the 2 s hang timeout and restarted it from scratch; three in a row = a broken scene. Now a worker is
      "starting" until its first `Frame`: before `Hello` moving CPU time, major faults or IO wait (`D`: one fault
      outlasted the quiet window) keep it alive, after it only paging in does (CPU work then is the `LoadGate`'s,
      whose cap `tests/scene.rs::starved_scene_load_outlasts_the_load_timeout` holds — counting CPU there broke it), ≤
      50 s from spawn (`tests/worker.rs` `slow_start_is_not_a_hang`, `slow_first_render_is_not_a_hang`,
      `endless_start_is_hung_at_the_cap` RED before; `stuck_start_is_hung`, `busy_first_render_is_hung`). The
      harness's deadlines (`tick_until`, `Harness::within`) no longer count time a source is still coming up. After
      the hello part alone: 3 left under the same load (a first-render kill, a broken B's restarts counted against its
      8 s, `align_end_video_a_to_scene_b` 40 ms off its 34 ms at load — it now fails on its own "B came up late"
      message when B's start, not the alignment, is the problem; a 10 s A for B's start drifted −35 ms under CPU load
      alone, so A stays 3 s, and it requests with ≥ 1.5 s of A left: its "A's last iteration" failure (once on a busy
      box, again after a reboot under btrfs-cleaner) was a request in A's last moments); the first-render grace, the
      50 s cap and restart-aware deadlines came after, unproven under IO load (the runs stopped: owner on the desktop,
      disk 95 % full) — checked with CPU load + unloaded only. **Run on a quiet night, not green yet:** under `bash
      scripts/test-lock.sh`, 2 writers `while :; do dd if=/dev/zero of=<scratch>/io-N.bin bs=1M count=256
      conv=fsync,notrunc status=none; done`, plus every 3 s `os.posix_fadvise(fd, 0, 0, POSIX_FADV_DONTNEED)` on the
      debug `liascape-scene-worker` (own `CARGO_TARGET_DIR`) and each library `ldd` lists for it (146 files); IO
      pressure `some` avg10 40–60 %, load ~13 on 24 threads. `cargo test --test transition` 2× on the whole tree at
      1c6ae31a (its three files alone no longer compile against today's code: `WorkerState::Spare`): RED 13/32 and
      10/32 failed, the family above (`scene_b_load_error_keeps_a`, `slow_loading_scene_b_is_waited_for`,
      `s_to_s`/`s_to_v`/`v_to_s_each_method`, …). 3× on the change: 5, 2 and 3 of 32 failed, not 0 —
      `scene_b_broken_mid_effect_snaps_back` 3/3 (its 8 s effect ended and handed off before the third crash: nothing
      pauses an effect while B restarts and each cold restart took ~4 s; now a 60 s effect, 2/2 green under the same
      load), `align_end_video_a_to_scene_b` 3/3 on three different checks (B came up at 5.4 s after A's 3.2 s end;
      progress 1 at 53.8 ms before A's last frame ended; B came up at 44.9 s — a start near the 50 s cap), once each
      `align_end_full_live` ("A's last iteration: loop off while waiting" — no ≥ 1.5 s-of-A guard like the V→S
      test's), `rapid_interrupt_chain` (0 commits: its fixed 100 ms gaps never let a B come up),
      `v_to_s_each_method` (full-live "A kept playing") and `scene_a_align_end_starts_at_once` (A's own start took
      ~47 s, past `within`'s `LOADING_CEILING`). `--test supervise` 8/20 failed and `--test program` 21/73, nearly
      all on wall-clock come-up waits outside the harness: "never came up" / "serve socket never came up" (the
      15 s `serve` socket wait in `Sup::start` and program.rs's server start, 5 + 19 tests),
      `gives_up_without_compositor_after_backoff` (110 s for a 1.6 s budget, 10 s allowed),
      `sigterm_during_compositor_backoff_exits_at_once` ("never entered the backoff", 10 s),
      `crash_restore_ignores_start_mode` (time_pos 1.367 < 1.5 after the restore), `broken_scene_advances_now`
      (no broken advance in 30 s), `timer_mode_switches_every_interval` ("step: no frame within 2 s"). **Cold `serve` start under IO load is paging, not the player
      (measured):** one `serve --headless` start + one synthetic scene, `strace -f` and `/proc` stats
      (delayacct): unloaded socket 0.04 s, `hello` 0.25–0.29 s, scene ready +0.2 s; 2 writers alone no slower;
      binaries + libraries evicted cold, no writers: 151 major faults cost 0.05 s; cold + writers + the 3 s evicter:
      socket 0.95–5.2 s, the player's block-IO wait 0.96–4.93 s against 0.3 s CPU. In the slowest (5.2 s) 4.90 s
      is exec → the Rust runtime's first syscall (the loader mapping 141 libraries: 0.17 s of syscalls, the rest
      relocation page faults), 0.20 s `serve` → `bind` with no syscall ≥ 20 ms; the loop never waits on IO before
      `hello` (the startup snapshot's `fsync`s run on `lia-snapshot`, 65–170 ms each); the scene worker's start is
      `filemap_fault` (kernel stack samples). So the come-up waits are start-aware now
      (`tests/common/come_up.rs`: past its deadline a start is waited for while the process tree moves — CPU, a
      major fault, a thread in `D` — ≤ 120 s; guard `come_up_waits_for_progress_not_for_a_stuck_start`, RED with a
      wait that never gives up): `Sup::start`, `Sup::crash`, program.rs's `spawn`, and the two compositor-backoff
      tests; `align_end_full_live` requests with ≥ 1.5 s of A left, `rapid_interrupt_chain` has the mixed chain's
      condition-based gaps, `scene_a_align_end_starts_at_once` and `bad_target_keeps_a` time their wait from the
      request, not from A's own start. Rerun under the same load (IO `some` avg60 44 %): transition 3, 1 and 2 of
      32 failed, supervise 5/21 and 2/21 (was 8/20), program 4/73 (was 21/73), no come-up failure left. Left, all
      slow IO against a product deadline, not a test's wait: `align_end_video_a_to_scene_b` 3/3 ("B came up at 47 s
      / 4.7 s / 3.1 s, after its effect was due": a check of the alignment needs B's cold start inside A's last 3 s
      iteration), `scene_b_broken_mid_effect_snaps_back` once (B's three cold restarts outlasted its 60 s effect),
      `cancel_waiting_restores_a` (a 10 s video's "no first frame within 34 s", the recipe's own
      ready timeout), `crash_restores` (hello 2.4 s after the crash, 1.5 s budget), `clean_quit_not_restarted`
      (no exit 5 s after `quit`: the final snapshot's `fsync`), `fourth_restart_in_a_minute_starts_without_program`
      (snapshot not matched in 20 s), `spare_worker_dies_with_the_player_and_returns_after_the_restore` (no spare in
      15 s), `program_survives_a_crash` (the history above), program.rs's stepped "step: no frame within 2 s" (3
      tests) and `vram_stopped_scene_advances_without_broken_flag` (8 s). Under heavier IO (4 writers, eviction every 0.3 s, the test binaries evicted
      too) starts outlast 50 s and frame-timing checks fail: past what the suite can hold.
      `program_survives_a_crash`'s other failure (history with a 4th, requested item: a read landing between the
      timer's request and its commit) now waits for `phase: playing`. Its post-crash "program idle, item 0 from 0"
      state (once, load ~40) is unexplained: a failing `tests/supervise.rs` test now keeps its root (event log,
      snapshot, stderr) and prints where.
      Not a margin: `i2_switch_while_gated_never_leaves_a_playing_source_silent` (~1 in 8 under CPU load) was
      a real bug — a resuming pause gate was dropped on a second clock read after its last `ramp_db`, so
      `gain.pause` stayed a hair under 0 dB for good (−0.0003 measured; −0.04…−0.56 dB with a 2 ms stall
      injected, 4/4 RED). The drop now writes the exact 0 dB.
      **Adapter IT (`scripts/test-liascape-player-adapter.sh`) — fixed (2026-10-27).** Reproduced with the IT and 16
      CPU burners pinned to 8 cores (`taskset`): 3, 1, 1 and 2 failures in 4 runs (16 unpinned burners at load 26:
      0). Causes, none a margin: fixed sleeps before reading a state that converges (the first `/apply` not on
      screen after 1 s; a setting not landed after 0.3 s); the pending B of the R61 section (dee, 10 s at 1.25×)
      handing off to bee (its own 40 %) before the SIGSTOP section's last read (`after SIGCONT → −23.88 dB`);
      the speed-drop check looking a fixed 9 s after the drop, past E1's REAL end when the drop landed late;
      the drag sections' 8 s fades running out (`null dB`); a python spawn per poll missing L1's 0.7 s window
      (and a stale E2 corr from an earlier section arming it at once); `/playlist/play` once taking its full
      10 s curl timeout, so "handoffs in 9 s" counted 17 s; reads after a window taking seconds (3.4 s for
      four), so "what was on screen at t" read a later state; an import past `post`'s 10 s; the WebSocket
      client not up 0.5 s later. Now: `waitfor` condition waits on a real deadline for every converging state,
      the pending B cancelled once its part is done, windows measured from the clip's own position (the old
      backstop bound + 3 s ≤ the check ≤ E1's end − 1 s; the restart windows close 6 s after E1's end), rates
      and "at t" judged by the events' own `t_mono_ms`/`t_wall`, 60 s fades, a 60 s import timeout. Fixed
      windows stay only where the window is the check (no switch in N s) and the latency bounds keep theirs
      (< 500 ms SIGSTOPped, < 100 ms `/preview global`: those two DID fail once at load ~45–50 with other
      agents' builds on top — load genuinely breaks them there; left alone). After: 115/0 in 2 pinned runs at
      external load ≤ 22 (+ runs at 33–50 whose remaining failures were the next items). R81's "reapply after
      the restart" check used to match ANY earlier reapply line; it now needs one after the kill — or the
      identical line < 10 s before (the adapter log drops repeats: see the stale snapshot below).
      **Product, seen under IO load, not fixed (reported):** (a) the snapshot lagged a switch by 2.4 s (fsync on
      a busy disk), so a supervised restart brought back the PREVIOUS wallpaper (dee instead of a) and R81
      re-applies settings, never the wallpaper; (b) an in-place upgrade failed: the old compositor's clean
      quit took 3.1–3.3 s (`player.quitting` → `player.exit`), `QuitOrKill` escalated to SIGKILL, the new
      player didn't answer within `UpgradeInPlace`'s fixed 3 s, and the backend fell back to a plain
      `serve` (no `--restore`, no `--headless`).
      **Stepped `step` timeouts — a real bug, fixed (2026-10-27).** With 16 burners pinned to the test's 8
      cores, `settings_reach_pending_b` + `stepped_align_end_reveal` failed EVERY run (8/8, also once
      `hotplug_added_before_running_joins_transition`): `no frame within 2 s from src1 (t=2.5–2.8 s, waiting
      for frame)`. Instrumented: mpv queues each step's NEW frame to the VO in the playloop iteration that then
      emits PLAYBACK_RESTART, so the loop rendered it before pumping the event (every step under load); the
      step then only completed on mpv's REDRAW after the restart (`next_frame_is_redraw` = true), which didn't
      come at 2.8 s of a 3 s clip with its loop off. `StepSeek::target_frame` now counts a non-redraw frame
      rendered after the seek's reply, before or after the restart (a redraw before the restart is the
      previous step's frame and never counts); completing on it, the step reads `time-pos` once (stepped
      only) so it still returns a settled state (`player_pause_freezes_*` saw the frame's `time-pos` arrive a
      step later otherwise). The `t=0.000s, waiting for seek reply` variant (1 in the 8 before-runs, 1 in 11
      after): the source's OPEN took the whole 2 s (`source.ready` at the deadline), the seek it then sent
      timed out at once — a source that had to open now gets a fresh `STEP_TIMEOUT` for its seek once ready
      (one not ready by the first deadline still times out). After both: 0/10 loaded runs of 7 tests, full
      `api`/`sources`/`supervise` green.
      **`tests/supervise.rs` — fixed (2026-10-27).** CPU burners alone: 0/43. With 4 of the 16 writing +
      fsync-ing 32 MiB files and 4 copying 256 MiB buffers: 11/14 runs failed — `wait_snapshot` (300 ms / 1 s:
      the snapshot is fsync'ed twice) and `supervisor_sigkill_reaps_child_fast`. Measured there: the child's
      PDEATHSIG SIGTERM (`player.quitting {why: signal}`) 3.5–10.3 ms after SIGKILLing the supervisor (57 runs),
      but its clean exit (final snapshot fsync'ed) 0.1–11.8 s. The test now asserts the signal ≤ 300 ms (the
      point) and the exit on its own within 30 s; snapshot waits are `SNAPSHOT_WAIT` 20 s. After: those 0/19;
      `crash_restores` still fails 6/19 there on its 1.5 s `RESTART_BUDGET` (hello 1.5–3.6 s after a SIGSEGV
      under IO load) — a stated latency budget, kept; measured, not fixed.
- [ ] **UI × player-state matrix** (`scripts/test-ui-matrix.sh`, driver `app/shell/probe-matrix.js`: every
      playback control of the real UI + every keybind command × idle / single / playlist / effect running /
      align:end pending / paused / paused mid-effect / no output / muted, hermetic). Fixed from its first run:
      trash left items in the playlist (a rotation played the missing file; an armed switch still fired to
      it), trashing an item whose switch was requested but not yet running kept it playing, undo didn't put
      it back; keybind next/prev/random on a single wallpaper switched behind the UI (now forwarded to the
      running backend); keybind volume reverted by the next UI save; play-from saved the playlist bar reordered; Play
      / play-from while paused stayed paused; `previous` at the first item with an armed advance relaunched
      the current one; mute while paused never reached a source (setting ramps on the frozen clock); the
      installed app got no WS events and lost its localStorage prefs every launch (random port = new origin).
      **Round 2** (2026-10-25 night): `--jobs N` runs N hermetic stacks in parallel (default 6; full run
      40 min serial → 14.5 min at 4 → 10 min at 6 → 8.3 min at 8 but 13 cells timed out entering their state
      (all passed alone); ~0.8 GB each, capped by MemAvailable, the run stops under a 3 GB floor;
      `LIASCAPE_MATRIX_NICE=1` + `--jobs 2` next to someone working — 4 stacks lag the desktop); the window is
      SHOWN on the private Xvfb — hidden it rendered no frames (rAF never ran: framer-motion/WAAPI exits never finished, dnd-kit's rAF-aligned pointermoves coalesced so a drop
      saw a stale target, gifs/the live bg sat paused unfocused). ~90 new cells, each only in the states its
      halves share: playlist bar drag-reorder through real input events (`sendInputEvent`), remove (X / context
      menu) of the shown / incoming / other item, Save / Load modals, the playlist-settings modal (interval,
      0 s on the way, wait-for-end, shuffle, transition off / duration / effect), the global Rotation section
      + transition method + global interval vs a playlist following the globals (opt-in states
      `pendingGlobal` / `playlistGlobal`) and one with its own override, multi-select (Ctrl+click: trash,
      trash + undo, toggle add / remove, the settings modal on both live sides; Shift+click range + the
      Delete key; Ctrl+A + Delete + Undo), the card's own toggle, a
      saved playlist overwritten, two controls in a row (slider drag → next, pause → play-from, mute →
      next, a global setting → next, next+next, next+prev, preview drag → close → reopen, remove / drag /
      load / transition change → next, two card applies / playlist bar clicks in quick succession, two trashes + two
      undos, pause → interval change: the rotation holds until the resume, a slider drag closed with Escape
      at once), a settings save/load race. Fixed: settings.json was written in
      place — a read mid-write got the C# defaults, applied live and saved back over everything (/settings'
      own `prev` → an engine flip, the Steam tokens gone); an armed align:end switch kept the transition it
      was armed with (playlist + global transitions, method) — it fired the old effect at A's end; removing
      the playing item from the playlist bar restarted the rotation from the top (now: from its place).
      `LIASCAPE_MATRIX_DLL=<older build>` / `--ui-dir` show a fix RED.
      **Round 3** (2026-10-26): 42 controls / 112 cells (full run now 709 cells: 681 pass, 28 structural skips,
      20m48s at `--jobs 4`). The rest of the global Settings page: Rotation
      wait-for-end / advance-on-end vs a playlist following the globals (`playlistGlobal` / `pendingGlobal`)
      and one with its own override, the playlist's "Override global rotation" both ways while armed;
      Normalize audio (on / off / target preset / switched on unmeasured / then next / across a NoAudio round
      trip — the oracle now checks every live source runs ITS OWN item's loudnorm); appearance (theme, aspect,
      card size, gifs, live bg), every source sampled back to back while the
      change saves (nothing may move, even for a moment); auto-mute against a PRIVATE PulseAudio the script
      starts (own socket under the stack's runtime dir, one null sink, no device / D-Bus / autospawn — the
      session's audio server is never seen; no pulseaudio → the cells SKIP): a synthetic stream mutes every
      live source in every state and unmutes after the delay, B comes up muted, toggle-mute around it, off
      while muted, mpv's own stream and one under the level threshold never mute, mute / unmute delays. The
      order a shuffle plays (the backend's contract: each cycle one pass in a fresh order, no repeat across
      cycles, shuffle on mid-session plays the rest once first, previous walks back through what played,
      Sequential again = the playlist bar's order). Seven chains of three or more controls. The volume keybinds with
      overridden items. Read-while-save races on playlist_state.json and index.json. Fixed: normalization reached `cur:*` only — an effect's A, a pending B and every
      source while no output shows one kept the old `af` (RED 9 of 20); a loudness measurement landing while
      its item played was never applied, it played un-normalized until its next switch (RED 3 of 3); every
      settings save (a theme change too: the UI posts the whole object) set `srcs:*` to the playing item's
      volume + speed and fixed the others up after — for one round trip an effect's other side / a pending B
      ran the playing item's (RED 12 of 20, deterministic with back-to-back sampling); the volume keybind
      pushed the new global onto a playing item with its own volume — it jumped off its override until the
      next settings save snapped it back (RED 10 of 10). Decided: the keybind is the keyboard twin of the global
      slider, so an overridden item keeps its volume (option: make it bump the playing item's override).
      playlist_state.json and the library's index.json were written in place: a read mid-save got a null
      playlist (the UI's init then held the DEFAULT playlist settings — the full run's pending × plAdvanceOff
      failed that way) or an empty index (every override read "follows the global") — RED 3–12 of 240 / 7–13
      of 360 reads per run; now atomic (`AtomicFile`, temp + rename) with a retried parse.
      Then the LOST update (the likely cause of the merged run's `paused × itemVol|playlistBarVol:other` — "k3
      volumeOverride null" under load, both passed alone 3/3; inferred, not reproduced in those cells): trash,
      undo, the WE sync and the direct-download reconcile loaded index.json, worked, and saved their copy back
      outside `LibraryStore`'s lock — over an override saved meanwhile. `race:indexLostUpdate` (40 k1 volume saves
      while k4 is trashed + undone ×15): RED 3/40 and 2/40 lost; every index write now goes through
      `SetMeta`/`Remove`/`UpdateIndex` under the one lock (`SaveIndex` private) — GREEN 3/3 runs.
      **Not covered yet:** scenes (liascape-player plays
      them since Phase 2 Task 11 — the matrix cells are Task 12), Browse/download/Steam (network + accounts), per-monitor content (no per-output wallpapers in the
      backend yet), auto-mute's "Only if MPRIS player active" (needs an MPRIS player on a session bus — a
      private dbus-daemon + a fake player would make it hermetic; not built), Settings → Clear settings / Autostart / Resume from last / Debug mode, a shuffle with advance-on-end (the
      program's own next; 12 plays of ≥ 10 s clips is too slow for a cell), deleting a saved playlist (no
      UI for it).
- [ ] **Speed storm leftovers** (`src/player/tests/onmachine/speedstorm.py` — live, bus muted; fixed in the same
      round: the adapter's aligned-switch backstop, the 1× tempo-filter rebuild holes, the align:end estimate):
  - [ ] **Stall breaker trips without a slow player** — 6 trips in ~25 min of storm (the request after a trip
        and the R81 reapply then reset a drag), while every verb answered in < 3 ms and 6860 direct pings never
        took > 50 ms; one trip put the queue at its 256 cap (new sets dropped) and failed the storm's own
        restore sets. Not reproduced in a 4 min re-run once the trip got its own log line (`no reply to …
        (waited …; gen2 GCs …, thread-pool queue …)`) and the `loop` probe got `max_request_ms/cmd` (handler
        time used to be outside `max_busy_ms`). Next trip: read that line first.
        **Re-run 2026-11-03 03:59–04:25** (`speedstorm.py`, drag 540 s / global 540 s / flood 420 s, live, 315
        items): **no trip** (no `no reply to` line) — not reproduced in 25 min either. But the command queue hit its
        256 cap twice (04:08:45 at the drag → global edge, 04:24:57 in the 50/s flood) and dropped one queued
        command each time, despite the per-key coalescing — so ≥ 256 non-coalesced commands were pending: find
        which (switches/barriers from `/next` every 8 s? keys that differ per value?) before trusting the cap.
        — **cap hits explained + fixed (2026-11-03, `queue-cap`)**: both hits were the storm's own loops over
        every item's `/library/speed` (04:08:45 = drag → global edge, which clears all 315 overrides; 04:24:57 =
        the restore after flood 420 s + settle 10 s, which re-sets them), not the drag/flood/`/next`: each
        `ApplyOverride` was its own `override:<path>` key → 315 distinct keys, and the worker (each pass + the
        `program:items` push of 315 items it triggers) is slower than the loop. The dropped one was some item's
        override pass — the playing item's possible (its speed then stays wrong). Now per-item passes are a
        **batch** (`QueueBatch`: `override`, `sceneloudness` — one pending pass over every item since it ran),
        and a cap drop logs the pending kinds (`dropping <kind>; pending N: <kind> ×n (k keys), …; running …`).
        Self-test "per-item override burst": 317 overrides behind a clog, the playing one last → depth 3 (the clog + the batch + the items push), its
        speed lands (RED: depth 256, dropped, speed stuck at the preview's). The stall-breaker trips above stay open.
  - [ ] **Shared looping A on `align:end`** caches its boundary (`target_end`, from the drop + k·length at the
        old speed) — a speed change doesn't move it. Unused by the backend today (same wallpaper on every
        output = never shared); re-anchor at the next wrap when per-monitor wallpapers land.
  - [ ] **Missed frames scale with content fps** (render worker: 2.2–3.3 → 1.8–2.5/s at 2× 1080p120 — better, not
        gone; what's left is the loop's own compose/present): steady 2× → 0.0/s, 2× ±0.05 every 90 ms → 0.65/s on the
        240 Hz output; random 0.25–4× (up to 240 fps content) 1–1.4/s vs 0.16/s at 1×. Phase 2 render worker.

- [ ] Not ported (found in the C6 decode): WE's `g_PointerPositionLast` starts at 0 0, so a freshly loaded scene's first
      frame sees a move from the top-left corner to the cursor; ours places the first position as a jump (0106).
      Single frame, likely invisible — check against a WE reference before porting.
- [ ] Desktop pointer on Sway/other compositors: no global cursor source (Sway's IPC has none) → surface pointer.

## Backend structure
- [ ] Prune `docs/decisions.md` (near its 30,000-char budget) against its own bar, "write it when
      someone would otherwise fix it back": delete entries nobody would reverse
      (Electron + React, "a work of art", focus rings only while tabbing, …); cut entries that restate a rule to their
      why plus a link. Target ~18–20k chars. Rules citing a removed entry's heading get updated (check-rules).
- [ ] One source of truth for the player's command API: the C# adapter's request/result/event types
      (`src/backend/Player/`) are hand-written copies of `src/player/src/api/` shapes; a renamed field only shows up
      when the adapter integration test happens to exercise it. Derive a JSON Schema from the Rust types (`schemars`),
      commit it, and add a test that checks it is current and that every C# DTO field exists in it with a matching
      type (or generate the C# types from it). Same idea later for the UI's `api/client.ts` vs the backend's web API.
- [ ] The shared HttpClient (`HttpClientProvider`: the scrapers' pages, the sites' downloads, steamcommunity.com)
      follows a site's redirects to any address, this machine and the LAN included. Only the sites' own origins are
      asked (an import from a link picks only the path), so it takes a source site that redirects inward. Give the
      shared handler's connect the image proxy's public-address check (`ApiSecurity.PublicOnlyHttp`), with a test
      switch for the loopback fakes every hermetic suite points it at.

## Older backlog
- [ ] `scripts/test-backend-stop.sh` § libop flakes on its "proved nothing" guard ("libop: an encode runs … got no";
      2 of 6 runs on switch-flip, 1 of 1 on lp-player, 2026-11-26 night): the High clip of a 60 s 1080p fixture
      now encodes in ~2 s, and the four `/clip?info=1` calls before the `pgrep` check can outlast it (the log shows
      a.mp4's clip made, the second job's ffmpeg never seen in the 10 s window). Make the fixtures' encode outlast the
      requests (longer or larger fixtures, or check after the first request), not a longer wait.
- [ ] `scripts/lwe.sh --nix` loses the caller's `LIASCAPE_LWE_CORE_DIR`: the devShell sets it to the store core,
      so `build` tries to install into the read-only store. Workaround: `nix develop -c env
      LIASCAPE_LWE_CORE_DIR=<dir> bash scripts/lwe.sh build …`. Fix: carry the caller's value (or the
      `build/lwe-core` default) across the re-exec.
- [ ] Optional: reword the stale "WIP" commit titles `161bf0f` / `8c5c0e6`. They're pushed, so this needs a force-push;
      owner's call.
- [ ] **Scene A's sound warbles during a transition** (owner 2026-11-06, not always; maybe headphone-specific — they
      changed headphones recently): when the outgoing wallpaper A is a scene, the transition sometimes plays "loud quiet
      loud quiet", "like audio in reverse or some ghost". **Not reproduced (2026-11-06 night, 39 recorded transitions)**
      on a private PipeWire at the owner's quantum (64, real-time) with a private headless player (two outputs at
      144/240 Hz): scene→video, scene→scene (incl. both with sound), scene→synthetic; fade, rotateTransition,
      parametric_glitch, static_wipe, splitSlideOutVertical, DirectionalScaled, GlitchDisplace, VerticalClose,
      TilesWave, randomNoisex, angular, x_axis_translation; full-live, reveal, frozen; A at 0.8×/1×/1.25× (WSOLA on);
      the compositor SIGSTOPped 4–8× mid-fade (the owner's 13–34 s `worker.host_stalled` gaps, in small); and the
      owner's own pairs from their 2026-11-06 log (Workshop copies: 3432999904→MIKU_MK2, 2783122117→壁纸循环,
      2672425887→EP05_01m, 1864677589→Miku Miku, 3243449890→3432999904, 3593587273→3419466417). Each trial recorded
      the sink AND A's own stream (`pw-record` on `liascape-player-scene.<id>`). **A's stream is the scene's own sound
      × the equal-power fade, to the dB:** decoding the scene's sound file and aligning it, A − source − cos-fade
      stays within p95 0.18–0.44 dB, max ≤ 1.03 dB over the fade (13 trials whose scene has one sound file and
      aligned; the compositor-stall one 1.63 / 2.97 dB — the fade held while stopped, as designed). The "loud quiet"
      dips seen in 2672425887's fade are in the music itself: the source has them at the same ms.
      A synthetic tone A under heavy real B scenes: no phase jump or hole on the sink. The debug dropout detector:
      fit ok, 0 drops on all. Ruled out with that: the WSOLA stretch (owner's A speeds were all 1.0, nothing in a
      transition changes a speed — `compress_to` only rescales progress/gain), the worker's gain path, gate and
      clip, a stalled loop, the auto-mute (by-pid ownership of worker streams), scene loudness reports. Not covered:
      the owner's real output chain (EasyEffects convolver + EQ on the HDB 630, quantum 64 set by another client),
      a real compositor stall of seconds. Tools for the next try (or the owner's own machine):
      `src/player/tests/onmachine/transition_audio/` (`rig.sh up`, `record.py`, `srccmp.py`, `afade.py`,
      `sine.py`). Next step: when it happens, note the time and whether A's sound or B's is the one warbling (most
      of the owner's 2026-11-06 scene A's had no sound at all — 3042492564, 2638125030, 3419466417, 3104056709 —
      so the warble may be B's video fading in).
- [ ] Randomized matrix sequences (5–20 random controls, the oracle after each) — optional, owner to decide.

- [ ] **Matrix shard hung in `scene × sceneProp:restart`** (2026-10-28, the `--changed liascape-player --jobs 2` run for the
      fix above): shard 0 stopped after `sceneProp:set` for 30 min (stack healthy — backend `/health` 200, the player's
      `state` fine, the scene's worker running; the probe idle), killed by hand; the cell and every scene cell after it
      passed on a rerun (31/31). The probe has no per-cell deadline and two waits without one: `ctlClient`'s
      `connect()` (its timeout only starts after the connection) and `js()` / `executeJavaScript`. Give a cell a
      deadline (→ ERROR + the stack's state) and `connect()` its own timeout. Electron ignores SIGUSR1 here (no
      inspector), so the next one needs that deadline to say where it waits.
- [ ] Optional: a backend instance id in a WS hello (the page could tell a restart from a dropped socket). Not needed
      while every reopen re-reads; only worth it if `resync` ever gets expensive.

## Follow-up projects (each gets its own brainstorm)
- [ ] **Experimental: render a scene with real Wallpaper Engine** (owner, 2026-11-06: "maybe as a future
      experimental feature"; after the port, not instead of it). An opt-in per-scene backend that runs WE itself under
      Proton and imports its frames as a graph source (dmabuf, like the scene worker), for scenes our port still gets
      wrong. Watch [wallpiper](https://github.com/ejalxndr/wallpiper) (MIT, early: runs WE under Proton, patches the PE
      APIs WE needs, pipes frames as zero-copy dmabuf to a desktop portal) — borrow or integrate once it matures. Open
      questions: Steam running/logged in (DRM), cost per instance (RAM/VRAM/start-up), bridging pause/transitions/
      audio bus/pointer/properties/per-monitor, a clean WE install. The reference-capture setup
      (`scripts/dev/we-ref-capture.sh`, `docs/player/spikes/we-proton.md`) is its first half. wallpiper reviewed
      and run headless 2026-11-06 (`docs/player/spikes/wallpiper-ref.md`): borrow its Vulkan dmabuf capture layer
      and `GetCursorPos`/Progman shim, not the daemon (global `wallpaper64.exe` kill, Steam-client registration via
      Proton's steam.exe, one session per user, upside-down frame grabs). Steam is not needed: WE ran as app 0.
- [ ] **Deferred (owner, 2026-10-29: "overengineering at this time"): the app's background vs the desktop for
      scenes** — `WallpaperBg` can only play a video, so with a scene on the desktop the app shows the last video /
      a random one (a different wallpaper entirely). Options: a transparent Electron window over the real desktop,
      or the player streaming its output frames to the UI. A gif preview was rejected (360p).
- [ ] **Deferred from Phase 2**: the `g_Daytime` uniform (LWE's core never updates it, it stays 0 — spike
      `lwe-core.md` §4.2; needs a host-side clock-of-day feed); scene-compatibility patches from the corpus
      (**Phase 6**, below).
- [ ] **Sidebar type tags** (owner, 2026-11-12: "drop the scene/video for the while"): components/sideTags.ts hides
      "Video" / "Scene" in both sidebars; revisit with the types above (show the type once there are more than two?).
- [ ] **Per-monitor audio mixing policy**: with different wallpapers on two monitors, both are audible at once
      (audio follows the picture). Decide: primary output only / loudest / all / user choice. liascape-player keeps a
      shared wallpaper playing and audible while it's still on another monitor; reveal/frozen hold a snapshot.
- [ ] Scene compatibility programme : import worthwhile upstream LWE PRs (#625 — closed unmerged, gap audit G06 —, #631, #694 …;
      #692, #677 and upstream `main`'s other fixes up to `38a5d60` are in since 2026-10-28 — UPSTREAM.md) as
      labelled patches. The corpus runner exists (Phase 2 Task 13:
      `src/player/tests/onmachine/scene_corpus.sh`, report `docs/player/reports/scene-corpus.md` — 92 ok, 1 static
      by design, 3 load_failed (3D) of 96 with LWE `bab619b`; it was 86 ok, 1 blank, 4 load_failed, 4 broken with
      `c902d06`); rerun it after every LWE patch. Its findings, each one an
      LWE (fork) patch, none in the player — every one reproduces with `liascape-scene-worker --lwe-smoke`, i.e. LWE's
      core alone; the report has each one's log tail + backtrace:
  - [x] **Real-WE references (goal pictures)** — done 2026-11-06, `docs/player/spikes/we-proton.md`. The real
        Wallpaper Engine 2.8.485 runs headless under Proton Experimental (umu, own prefix, own config, in
        `gamescope --backend headless`, no audio device, Steam not needed): `scripts/dev/we-ref-capture.sh <id>
        [--times …] [--prop k=v] [--pointer X0,Y0:X1,Y1 --pointer-time A-B] [--fps N] [--desktop]`, `--batch` over
        the Workshop folder. Every library scene has frames at 0.5 / 2 / 5 s in `docs/player/reports/we-ref/<id>/`;
        `src/player/tests/onmachine/scene_we_compare.sh` renders ours at the same times and ranks the differences
        (`docs/player/reports/scene-we-ref.md`). Rerun the compare after every LWE patch; recapture after a WE update.
    - [ ] Work down `scene-we-ref.md` (the fixes are follow-ups; this only measured). Since the scene clock
          (2026-11-06) the "time" rows are gone. Since the 2D round (2026-11-06 night, pin `92c1ada`) the top is 3D
          (3276522107: the 3D agent's), then the parallax scenes' 0.5 s frames (the late pointer, below), random
          particles / shafts (3490034653, 3478602089, 2561227934, 3363252053, 2511663284), random text (2951169110)
          and the open ones below (3463520581 and 3042492564 fixed 2026-11-11, fork 0123–0125; 3013489778 fixed 2026-11-10, fork 0118). Explained so far: each ranked scene's note (`scene_we_notes.json`).
    - [ ] 3042492564's clock (left after the 2026-11-11 fix): a faint dark rim where its `shine` rays raise the alpha
          outside the glyphs; WE shows none. The text's picture is premultiplied as WE's font pass leaves it (that part
          is measured), so how WE's shine combine keeps the rim light is open (its `BlendGlow` with the rays' alpha).
    - [ ] A compose (passthrough) layer named in another object's `dependencies` (3243449890's 16613, read by four
          clipping masks) keeps LWE's handling; WE sets flag 0x1010 on it too (the 2D round ported it for image and
          text layers only). 3243449890 has no WE reference yet.
    - [ ] The 0.5 s frames of parallax scenes (3233141951, 3219908811, 3363252053, 3354740764, 2951169110,
          3289734539): WE's pointer arrives with the capture's xdotool nudge after load and its parallax eases in
          from there; wallpiper (GetCursorPos hook) has it from the first frame. Nudge earlier, or take the 0.5 s
          frame from wallpiper.
    - [ ] 3184155462's cursor ripple vs the owner's Windows: WE's ripple force scales with the frame time (≈10× weaker
          at 120 fps than at 30); at a matched 30 fps ours is WE's strength. The owner's Windows WE (main profile,
          `/mnt/Windows/…/wallpaper_engine/config.json`) runs at **240 fps** (Ultra, MSAA x8; the Linux library's
          `config.json` copy is stale: 30 fps, x2 — don't read that one), so on Windows the ripple is very weak, while
          ours runs scenes at 15 fps by default → much stronger, as the owner reported. Faithful behaviour is already
          in (the effect follows the scene fps); to look like their Windows, Liascape's scene fps has to be 240 too
          (GPU cost). Open: whether Liascape should offer WE's fps presets / a per-scene "match WE fps" option.
          Refs: `we-ref/3184155462/ripple-*`.
    - [ ] A 2D layer of a WE flag-0x100 image (unknown meaning) gets no last draw in ours (the genericimage3 /
          genericimage4 half of this item is closed: the same pixels for every library layer).
    - [ ] A 3D scene's CursorEvent `worldPosition` (ours: scene pixels) and WE's type-5 hit branch (GH 0x1401b5600).
          The hit test itself is WE's since 2026-11-10 (the cursor's ray against the layer's quad; 3509243656's planet
          rings). Gap audit "3D scenes against WE, part 3".
    - [ ] Video-texture scenes (13) crash WE under Proton (`mfmediaengine`): a reference for them needs Windows'
          own Media Foundation in the prefix (from the owner's install) or a Windows capture.
    - [ ] Music-reactive references (3445973124 "with music"): a private PipeWire instance with a null sink as
          WE's default output, winepulse pointed at it, a track played into it (the spike's "Blockers").
  - [ ] **WE ↔ LWE gap audit → porting batches** (2026-10-29,
        `docs/player/spikes/we-lwe-gap-audit.md`). It has 185 rows: what WE 2.8.485 scenes do (decompiled, or from
        assets/docs) that the fork doesn't, each with the number of the owner's 96 scenes that use it. Port it in
        the batches below, highest usage × impact first. After each batch, rerun the corpus and the batch's own
        smoke/capture check. The WE captures the owner can take on Windows are listed in the doc's "Needs the
        owner".
    - [x] **B4 Text renderer.** UTF-8, multi-line, alignment/limits, a fontconfig `systemfont_*` (text vanishes on
          NixOS today), drawn as an image so effects/parent/rotation/parallax apply (T1–T8, E34, G13, G30). 45
          scenes. L. **Done 2026-11-04** (fork patches 0048 text layers are image layers + 0049 text strings and
          `"1 1 1"` colour properties + 0050 wrap/rows/spacing/script alignment, pin `6bc301c`). Decoded: text
          extends image, 300 dpi, WE's layout, placement and padding, the systemfont table. fontconfig finds
          Arimo / Comic Neue / Inconsolata here. host_api_test 58/58 (5 new, all failing on 5a365d4); 44 of 50 literal
          texts match the editor's saved height within 2 px. See the audit's "B4 result".
          - [ ] WE captures of two clock scenes (1884904087, 2134765860) for size and line layout (T10 is decoded;
                this checks it).
          - [ ] Cursor hit tests now reach text layers (they are CImages); check 2325974975's buttons still behave.
    - [x] **B7 Blend modes / framebuffer.** Copy the scene FBO before sampling `_rt_FullFrameBuffer` (a feedback
          loop today), `clampuvs`, `copybackground` (E27, E28, E30, E31, E33). 28 scenes. M.
          **Done 2026-11-04** (patch 0047, pin `5a365d4`; 0046 fixes B8's registerAudioBuffers scope check). All
          decoded from wallpaper64.exe: copy before a pass samples its own target, mode 31 = additive, clampuvs
          (default true) on the composite FBOs, compose layers draw their subtree, `_a`/`_b` parity. See the
          audit's "B7 result".
          - [ ] WE captures of 2883756643 and 3414858021 / 3432999904 to confirm the inferred parts.
    - [x] **B11 Particles, extended.** Child systems, the missing initializers/operators, control points, rope/trail
          combos (P2, P10, P15, P22–P35). 29 scenes. L; first read the operator interpreter from asm. **Done
          2026-11-04** (fork patches 0051 operators as WE's interpreter runs them + 0052 child systems + 0053 control
          points, pin `a209070`): P2, P10, P15, P22, P28, P31–P35. GH 0x140265800 decompiled in REA (no decompile
          timeout); opcodes, record layouts and the forms of movement, the ramps, oscillate*, attract, vortex and
          turbulence are in the audit's "B11 result". host_api_test 61/61 (3 new, failing on 6bc301c); corpus 93 ok
          on both cores, none newly blank; player tests 737/0/3.
          - [ ] WE captures of 3174556087 (rain splash children), 2288455459 (firefly trails) and an oscillating
                scene to confirm the decoded forms against WE itself.
          - [ ] P27 non-default bounds / limitbehavior / axis semantics (decode the spawn interpreter's case; 0
                scenes).
          - [ ] `controlpointangle0-7`, vortex_v2 (case 0x10), P24 cone, P25/P26: 0 library users and unread —
                listed in the audit's "Leftovers result".
    - [x] **B12 Puppet warp.** MDLV 0013–0023, skinning, layer mixing, attachments (G06–G09; PR #625 is closed,
          unmerged). 14 scenes. L. **Done 2026-11-04** (fork patch 0054, pin `1eb795e`): WE's MDL loader (GH
          0x1402873f0: the vertex layout from the mesh's format word, every MDLV ≤ 0023, MDLS/MDLA/MDAT by section),
          CPU skinning, the layer clock/weight/normal and additive mixing, attachments, and puppets without effects
          drawn in place. All in the audit's "B12 result". host_api_test 62/62 (1 new, failing on a209070); corpus 93
          ok on both cores, none newly blank.
          - [ ] A WE capture of 3463520581 or 3233141951 to check poses and the attachment's (inferred) form.
          - [ ] Physics bones (none enabled in the library; WE's simulation is on an unread rigid-body helper family
                reached from the mixer GH 0x140228470); root motion (MDLA flags bit 0, 18 bytes, undecoded);
                `autosort`/`index` layer order (0 users, not in the exe's strings).
          - [ ] The scripted layer API (`getAnimationLayer`, `playSingleAnimation`; S26).
          - [ ] B14 builds its static MDL meshes on `Render/Objects/Puppet.{h,cpp}` (normals/tangents are parsed for
                the layout but not kept yet).
    - [x] **B13 HDR bloom + FBO formats** (E35, E23). 5 scenes. M. **Done 2026-11-04** (fork patch 0055, pin
          `0d66ae8`): a `general.hdr` scene renders into half float targets and blooms with WE's HDR chain
          (hdr_downsample_bloom → hdr_downsample levels → hdr_upsample(_cubic) back up → combine, decoded GH
          0x1401afbf0 / 0x1401b3b10 / 0x1401b42b0); effect FBOs take the format they name (rg88, r8, the f formats,
          rgba_backbuffer half float with HDR); WE's LDR bloom defaults 2 / 0.65. host_api_test 64/64 (2 new); corpus 93/96
          on both cores, none newly blank. Result: the audit's "B13 result" (§ 5). Left:
          - [ ] `combine_dhdr_upsample` (HDR displays) and `combine_video_hdr` (not ported).
    - [x] **B14 3D scenes.** Perspective camera, 3D image layers, MDL meshes + `generic4`, lights/fog (G20–G29, E13,
          E14, E43). The 3 load_failed scenes below. L. **Done 2026-11-04** (fork patch 0056, pin `40f2b85`, which
          also carries B13's 0055): G24, G22, G25, G26 point/spot (E13), G28 (E14), `transparentsorting`, camera
          objects and the 3D shake; decoded addresses in the audit's "B14 result". host_api_test 68/68 (4 new,
          failing on 1eb795e); corpus 93 → 96 ok, none newly blank; player tests 737/0/3.
          - [ ] Left: directional shadow cascades, light clusters, volumetrics' SHADOW / COOKIE / fog / directional (point and spot volumetrics and shape objects: done in F2, 0086 and 0088); skinned/morphed models, PBR-mask component combos, REFLECTION; fog on image and
                particle shaders; the 3D camera's parallax and zoom (WE's 3D projection doesn't read the zoom; its
                other reader and the 3D parallax block weren't read — 0 3D scenes use either); E43 text `depthtest`
                (no-op in 2D, not ported); customsortorder's reader; hit-testing world-placed layers; an
                output-sized 3D target; WE captures of the three scenes.
    - [x] **3414858021 (owner report): head gone, cursor trail y-inverted.** **Done 2026-11-04** (fork patches
          0057–0060, pin `e814c25`): SceneScript `angles` are degrees (scripts turned the body 55°, the head and arm
          left the screen); a pointer-linked particle control point was y up in a y-down space (trail mirrored);
          the compose layer holding the head didn't compile (line continuation, a written varying, a vec4×vec2
          truncation, a stray `#endif` — all accepted now as WE does); a failed parent orphaned its children. The
          bright band across the lower screen went with the compose layer. Result: the audit's "3414858021
          result". Smoke: `--pointer X0,Y0:X1,Y1`.
          - [ ] `auto_sway` (3235948233, 3414858021's hair/cloth sway): `M_PI` from `common.h` used above where LWE
                pastes includes; hoisting the include's `#define`s builds it but the left cloth then vanishes — read
                the effect before enabling it.
          - [x] 3414858021's "WEDNESDAY" reaches the right edge (group x = user `x8` 0.967 × canvas) — WE's does too
                (the Wednesday capture, 2026-11-11).
          - [ ] Flag 4's reader (2026-11-05, audit "Attachment result"): not in the exe nor found in scenescript64.dll;
                flag 4 also marks shader constants annotated `"conversion":"rad2deg"` (GH 0x140192430), which a script
                would see in degrees in WE and radians in LWE — 0 library scenes script or bind one.
    - [ ] **Scene health report — pick fixes from it** (2026-11-04, fork patches 0061–0062 `WPENGINE_HEALTH`, runner
          `src/player/tests/onmachine/scene_health.sh`): [`docs/player/reports/scene-health.md`](player/reports/scene-health.md)
          — every library scene's silent losses (layers/effects left out, shader/script/asset errors, unsupported
          features, off-canvas layers). First run: 75 clean, 21 degraded, 0 failed of 96; after the shader rules (0064):
          79 clean, 17 degraded; after the coverage batch (0065–0070, pin `cbe4445`): 86 clean, 10 degraded, 0 failed —
          script errors 38 → 11, layers dropped 3 → 0, none worse. Batched by cause:
    - [ ] **Scene preview compare — every scene against its author's preview** (2026-11-05, runner
          `src/player/tests/onmachine/scene_preview_compare.sh`, notes `scene_preview_notes.json`):
          [`docs/player/reports/scene-preview.md`](player/reports/scene-preview.md) — a ranked "look here first" list
          (SSIM + colour histogram + edges + the worst local cells, the crop found by correlation; 3414858021 scores
          0.665 before its head fix, 0.32 after). Result: the audit's "Preview compare result".
          - [ ] camera zoom direction contested: 3516174947 letterboxed at its default "Lens size" 0.75, 3042492564's
                preview = our zoom 1; the decode (B5) and 3490034653's "Panorama" say zoom < 1 shows more — needs an
                owner's WE capture of 3516174947.
    - [ ] **WE coverage — the master gap list** (2026-11-04, fork patches 0065–0070):
          [`docs/player/spikes/we-coverage.md`](player/spikes/we-coverage.md) — everything WE supports vs our fork,
          item by item (SceneScript d.ts 2.8: 421 / 453 implemented, was 329; keys, blend modes, formats, object
          types, pass options) with library / stock usage and sizes. Pick work from its "Future batches":
          - [x] **F1 shadows + light cookies — done 2026-11-04** (fork patch 0071): the shadow pass and atlas (spot and
                point lights, the stock casters), spot cookies, tube and directional lights; result in the audit's "F1
                result". No library scene uses them (synthetic check). host_api_test +4 (RED on `cbe4445`).
                - [ ] Left: directional cascades (`g_LFeature_Shadow*`), WE's light clusters, 2.8.485's PCSS (quality
                      4), the `shadows` quality as a setting (medium now), `lightconfig`. (Skinned/morphed casters: done in F4, 0078/0080.)
          - [x] **F3 blend shapes + bone alpha, F4 skinned / morphed models + createModelData — done 2026-11-04**
                (fork patches 0078–0081, pin `00d7760`): the casters' SKINNING / MORPHING combos compile (sweep: the
                10 caster checks pass), MDMP blend shapes with their MDLA weight tracks and bone alpha on puppets
                (+ get/setBlendShapeWeight), skinned and morphed 3D models posed by their animation layers,
                createModelData / IModelData / createLayer ({ model }). Result in the audit's "F3/F4 result".
                host_api_test +4 (RED on bdafdde).
                - [ ] Left: bone physics (+ applyBonePhysicsImpulse, gravity/wind; IK done in F2), root motion /
                      `rootmotion`, MORPHING_MODIFIERS, IModelLayer's animation-layer API on models, `perspective`
                      model layers, MDLA v6's per-bone float track.
          - [x] **F5 perspective layers + F6 the stock-only particle operators — done 2026-11-04** (fork patches
                0082–0085): an orthographic scene's perspective camera (`perspectiveoverridefov`, GH 0x1401b4fd0) for
                `perspective` layers and perspective particles (35 scenes' systems now WE's size and depth), camera
                paths + camerafade, `sortorder` in WE's transparent sort; 20 stock-only operators/initializers (WE's
                form where decoded, else inferred and marked). Result in the audit's "F5/F6 result". host_api_test +6
                (RED on `bdafdde`).
                - [ ] Left: the `layerimage` emitter (CPU pixels of the layer), collisionmodel, the inferred F6 parts
                      (boids' forces, remap's function shapes, the initializers' runtime: an asm read of case 0x11 /
                      0x13 and the spawn interpreter GH 0x140260d80), vortex_v2, a camera object's own `path`/`queuemode`
                      (all empty in the library), text `depthtest`, customsortorder, the 3D zoom/parallax, WE captures
                      of the element previews (`assets/scenes/particleelementpreviews`).
          - [x] **F2 shape objects + volumetric lights, F3's puppet IK — done 2026-11-05** (fork patches 0086–0090,
                pin `127d63b`): the "VolumeLight" is WE's shape class (3319542538's light shafts now draw), point and
                spot `castvolumetrics` with WE's volumetrics pass and shaders (synthetic check; 0 library users), puppet
                IK chains (3042492564's arm follows its hand target; solver inferred). Result in the audit's "F2
                result". host_api_test +3 (RED on `5e65da4`).
                - [ ] Left: volumetrics with SHADOW / COOKIE / fog, directional volumetrics, the `volumetrics` quality
                      setting (medium); bone physics + applyBonePhysicsImpulse + gravity/wind (0 users); IK limits
                      (`ikce`, `ikrmin/max`); root motion; MORPHING_MODIFIERS.
          - [ ] F7 puppet hit boxes (S–M).
          - [ ] F7 CursorEvent.hitBox: decode where WE keeps a puppet's hit boxes (not MDLE/MDMP; likely the rest
                of MDLS, which LWE skips) — 0 library readers.
          - [ ] ITextLayer writes (font, padding, anchor, limitrows, limitwidth, backgroundcolor) re-laying the text
                (0 library writers); IEffectLayer.transformAttachmentToTexture; .tex flag 64 (a slice count, 0 users).
                .tex flags 2²⁰–2²³ done 2026-11-05 (0099): channel-built-from-a-component bits that define a
                sampler's `components` combos (PBRMASKS: 3477054430, 3509243656).
- [ ] Optionally offer our LWE patches upstream as PRs, with AI assistance disclosed. Upstream merged nothing since
      2026-06-20.
- [ ] Phase 3 battery findings (`docs/player/reports/phase3.md`):
  - F1: `frozen`: B's ramp-in starts 2–5 ms late in about 1 of 15 onsets (recorded on the sink; mostly S→V). At most a
    faint tick. Probably the same graph change as "F7 residual".
    **Closed 2026-11-04 with the F7 residual:** it is that lost cycle landing on B's first ramp samples — in frozen
    S→V, A's worker quits at the handoff and its stream's deactivation (1.5–6 ms later) raced the graph exactly as B
    (mpv, already flowing) ramped in; one quantum of zeros at the ramp's start reads as a 2–5 ms late onset. Async
    producers lose no cycle (0 of 60, two profiler runs); confirmed on the real outputs 2026-11-13: `programs.sh dropout`
    with `P3_RECORD`, real session, 80/80, 0 drops / micro-gaps / seams in every cell.
  - F2: pause when covered takes 374–401 ms against the plan's 350 ms (300 ms debounce + 30 ms batch + the rest).
    Closed 2026-11-02: the bound is now 450 ms; the debounce stays.
  - F3: the plan's "handoff vs A's end ≤ 1 frame": measured 33 ms against the nominal end, 19.7 ms against
    `source.ended`. Passes as one 30 fps clip frame, fails as one output frame. **Owner:** which was meant?
    **Fixed 2026-11-04 ("Hand Off When A's Last Frame Has Had Its Time") as "one output frame":** `source.ended`
    fires as A's *last frame is presented*, so a handoff 7–20 ms after it (the battery) cut that 33 ms frame short
    by 13–26 ms — B drawn over a frame the clip still owned. Cause: the full-live `align: end` aim subtracted half a
    clip frame from its end estimate "to centre the error", but `time_pos` is mirrored every tick, so the minimum
    already sits within a tick of the true end. Now aimed at the raw minimum. `tests/api.rs::
    align_end_hands_off_as_a_last_frame_ends` (144 Hz headless, real libmpv, 6 switches, handoff vs `Ended` + one
    clip frame): before −9.8…−13.7 ms (cut), after **+0.7…+7.3 ms** (held ≤ one output frame; bound −3…+2 output
    frames). The report's "nominal end" column (`start_ms` + remaining from a rate-limited `position`) over-estimates
    by up to 100 ms — not a reference.
  - F4: `--debug` only: the dropout probe costs 161 whole graph cycles of full-level silence in 460 s, right after each
    analysis; 0 without it. Find the cause before trusting a recording taken under `--debug`.
    **Fixed 2026-11-02 ("Spawn Dropout Decodes Without Forking The Player").** Cause: each analysis's ffmpeg
    decode had a `pre_exec` hook (for `PR_SET_PDEATHSIG`), which makes std `fork()` the whole compositor instead
    of `posix_spawn`ing (vfork). bpftrace on a private PipeWire: 48 forks for 12 analyses, 1.9–10.5 ms each
    (median ~2.4); while the address space is copied (and its pages turn copy-on-write) the in-process bus
    loopback and mpv's AO miss their graph cycles → 28 and 44 runs of exact silence (64–576 frames) per 12
    analyses on the recorded sink. Fix: no `pre_exec`; the death signal comes from `setpriv --pdeathsig KILL`
    in front of ffmpeg (util-linux; without it ffmpeg runs bare — SIGPIPE on its closed stdout + the 20 s
    timeout bound an orphan). After: 0 forks, 0 runs in 5 of 5 runs. Guard
    `tests/api.rs::dropout_analysis_never_skips_bus_cycles` (RED before: 28 / 44 runs). The probe no longer
    touches the audio it measures, so `--debug` recordings are trustworthy again. Only the battery's own
    re-run (`programs_steps.sh` with `P3_RECORD`, on the owner's machine) is left to confirm the 161 → 0.
    **Battery re-run 2026-11-02 23:00 (owner's machine, `programs.sh dropout`, `P3_RECORD`, release player,
    another agent's test suites loading the machine):** 47/50 — the same 3 `frozen` micro-gap FAILs as the first
    battery (1 + 1 + 4, the handoff work), 0 drops. The sink recording (2874 s): 23 exact-zero runs of 64–1023
    frames inside sound, every one exactly 64 frames; ~15 at the tone's full level (before: 161 whole cycles in
    460 s, 64–576 frames, right after each analysis — ~67× rarer per second now). The player's meter counted none
    of them as a micro-gap and they are one fixed 64-frame size, so most likely the recorder/sink side (under
    load), not the player's output — unproven. More likely still: the same single-cycle loss as "F7 residual" below (a
    stream's deactivation through the bus loopback, 64 frames each, invisible to the meter) — for the handoff work. Recording kept out of the repo (1.1 GB).
    **Settled 2026-11-04:** they were the F7 residual at mpv's streams (its AO deactivates on every pause and is
    destroyed at each teardown — the same race, Phase 2 § F7 residual), fixed by the async streams; the meter can't
    see them because its own capture sat in the same stalled cycle.
  - F5: `tests/api.rs` is flaky under the full suite. `scene_create_and_destroy_never_stall_the_loop` (destroy max busy
    3.25–3.56 ms against its 3 ms bound) failed 3 of 9 runs on `58eb5ec` and 4 of 10 on Task 14's branch; alone it passes.
    `scene_fps_change_is_live_same_pid` also failed once on `58eb5ec`. Not caused by Task 14.
    **Settled 2026-11-02 ("Measure Loop Stalls Without Waiting For A Core", then "Free Imported Frames Off The Loop");
    one driver limit remains, excluded by name.** (1) The 3.25–3.56 ms readings were the loop thread waiting for a core, not loop work: the `loop`
    probe now has opt-in scheduler accounting (`{"account": true}`: per stretch the thread's CPU clock,
    schedstat run delay and voluntary/involuntary switches → `max_busy_own_ms` = wall − run delay,
    `max_busy_at` / `max_busy_own_at` name the stretch). With the test pinned to two CPUs and four busy
    loops it reproduces: wall 3.4 ms = 0.75 ms own + 2.7 ms runnable, the stretch the test's own `probe`
    (the scene's `destroy` handler is 0.03 ms); idle, 0.5–1.4 ms. The test now bounds `max_busy_own_ms`
    ≤ 3 ms; RED with 5 ms of CPU or a 5 ms sleep injected into a scene's `begin_teardown`, idle (5.76 /
    5.52 ms) and under the hog (5.53–5.57 own at 5.6–16.8 wall). (2) **Caught 2026-11-02 ("Free Imported Frames Off The Loop"): NVIDIA's global driver lock.**
    Off-CPU stacks of the loop thread (`perf record -e sched:sched_switch` filtered to the player,
    DWARF call graphs, + `sched_wakeup`; ~100 recorded runs of the test, under the scene
    harness's `gpu_work` 4000 loop and under a pinned CPU hog): every sleep ≥ 0.2 ms the loop took
    in a measured window was in the NVIDIA kernel driver's resource manager, state D, in
    `nvidia_unlocked_ioctl` → `RmIoctl` → `rmapi{Alloc,Free,Control,Map,DupObject}WithSecInfo` →
    `serverTopLock_Prologue` → `rmapiLockAcquire` → `rwsem_down_{read,write}_slowpath` — one
    rwsem for every process on the GPU, held by another process's allocation/free (the harness
    loop starts and ends GL contexts every ~1.5 s; the owner's player and other tests too).
    Our call sites: **(a) destroy** — the dying `SceneSource` dropped in `SourceHost::sync` →
    `ImportedTex::drop` → `eglDestroyImage` (`rmapiFree`/`rmapiUnmap`, 0.2–1.4 ms per image,
    3–6 images); **(b) create/resize** — `ImportedRing::import` → `import_dmabuf` →
    `eglCreateImage` (`rmapiControl`) and `glEGLImageTargetTexture2DOES` (`rmapiFree`), 0.2–4 ms
    per slot (one create: 3.99 + 2.43 + 2.09 + 0.77 ms → 11 ms own); (c) the first composite of a
    fresh texture in a process (`BlitProgram::draw` → `rmapiMap`/`rmapiDupObject`, up to 26 ms)
    and `clear_transparent` (`rmapiAlloc`) — seen only in the warm-up scene, outside the
    windows. "Between the meter and the latch" was never seen; the earlier per-segment
    attribution most likely caught an import's sleep. **Fixes:** (a) moved off the loop — the
    image goes to one `lia-egl-free` thread (`dmabuf::free_image_off_thread`; the texture is
    still deleted on its context first; under the display lifecycle lock, skipped after a
    terminate via `DISPLAY_EPOCH`); 15 recorded runs after: no free on the loop, destroy
    windows 0.2–1.6 ms. (b) stays on the loop — a **driver limit** at this design: the import
    runs in `runtime::driver_call`, the `loop` probe reports its sleeps (`driver_blocked_ms`)
    and `max_busy_self_ms` = own minus them; the test bounds that. **Follow-up:** an async
    import (`eglCreateImage` on a helper thread, the ring's frames deferred until it lands;
    `glEGLImageTargetTexture2DOES` still on the loop) would take most of it off. Also found:
    the destroy window held the test's own `probe workers` (1.5–2.1 ms of CPU, 2.8–3.4 ms
    with its stretch under the GPU loop — 18 of 20 unrecorded runs near the bound, several
    over): now read before a second reset. Spawn (`posix_spawn` vfork) on the loop: 0.2–0.7 ms
    per spawn (bpftrace on `clone`), kept — a spawner thread delays the pid every
    kill/waitpid/reap path needs; not done. RED still: a 5 ms sleep (5.96 ms self) or a 5 ms
    spin (5.82) in a scene's `begin_teardown`, a 5 ms sleep next to (not inside) each import
    (15.5 ms self on create). One open trace: a single 1.8 ms voluntary sleep in a create
    dispatch stretch (fix-12, perf recording, not driver-attributed, not caught as a stack —
    most likely the spawn's vfork while the child waited for a core).
    `scene_fps_change_is_live_same_pid` (+ `per_output_scene_fps_gates_presents`): the failure was
    `VIRTUAL-2 at its refresh` (60/0 step); not reproduced (CPU hogs, 7 runs: 59.4–60.5). Both now judge
    presents against `min(gate, frames the scene latched in the same window)` (latched ≥ ½ the scene's
    rate) — cause unproven, the new check prints the baseline; RED with the gate bypassed (59.95 vs 15
    and vs 30).
  - F6: once under load (UI matrix `paused × playlistBarPlay`), a program loaded with "play resume → k1.mp4 (resumed)"
    and its timer switched to k2 357 ms later with a 600 s interval; rerun alone it passed 3 of 3. **Closed
    2026-11-02 ("Retime A Resumed Countdown To The Current Interval"):** a resume point (`resume.json`, key `bar`
    for the playlist bar) kept the timer's raw `remaining_ms` but not the interval it counted down from, and the
    resume committed it as is. An earlier matrix cell had played the bar playlist under "switch when video ends"
    with minimum 0 (remaining 0 — no countdown runs under `on_end`) or a short timer (`plInterval` 8 s); this
    cell loaded it with 600 s and resumed with that stale 0 / few seconds → the timer fired on the first tick
    after the commit (357 ms = the tick + B's load). Alone, no such point existed. Now the point saves
    `countdown_ms` (the timer interval; none under `on_end`) and the resume re-times it like a live interval
    edit (`resume::resumed_remaining` → `retime_remaining`; no countdown ran → a full interval). Guards
    `tests/program.rs::resume_retimes_a_countdown_saved_under_other_settings` (RED: on_end → switched one tick
    after the resume; 8 s timer → remaining 0 and a timer switch pending), unit
    `resumed_remaining_retimes_to_the_current_interval`.
  - F7: "Start over" + shuffle restarts every boot on the same item (138 on two boots, 2026-11-02). The program's
    `seed` is saved (`program/store.rs`) but its RNG state isn't, and `Prog::new` makes `Rng::new(seed)` each process,
    so a session start's "fresh shuffle" (`session_start` → `plan_start`) and every later random / effect pick replay
    the same sequence after each restart. Fix: reseed from the seed and something per process (or save the state).
    Closed 2026-11-02: the snapshot keeps each program's RNG state (`ProgramSnap.rng`), restored before
    `restore` / `session_start` (`Programs::restore_rng`), so the sequence goes on across processes; a
    snapshot from before it repeats once. `tests/program.rs::session_start_start_over_shuffles_anew_each_boot`
    (RED: three boots, one order).

