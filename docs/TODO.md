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

3. [ ] (owner) Scenes checked against real Wallpaper Engine, every feature, every scene, and as fast and lean as
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
4. [ ] (owner) Browse feels slow: the rest, now that the card pictures wait on neither the resolver nor each other
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

7. [ ] (owner) The owner's README replaces the agent-written one: `docs/Meat bag's Readme.md` (untracked) and branch
       `readme-preview` (8 commits: collapsible install steps per distro, shorter previews, a readable Settings image, a
       required / optional "You'll need"; `docs/preview/` holds its images, untracked). Bring it up to date with today's
       app (only liascape-player, the download modes, Start with your desktop, the welcome …), keep the owner's voice and
       layout, make it `README.md`, delete the branch and the untracked copies.

8. [ ] (owner) A Workshop download Steam's cooldown refuses still fails as "Download failed: Steam rate-limited the
       request." (`Helpers/WorkshopDownloader.cs` `SteamRateLimitException`, the error modal): give it the shared cooldown
       notice's words and countdown (`app/ui/src/components/SteamCooldown.tsx`, a 429 carrying `cooldownMs`) and start the
       download again by itself when the cooldown ends, as the sidebar's comments do. Guard: a probe-steam `cool:` cell.

9. [ ] (owner) Split the biggest files so agents can work in them: `src/player/src/runtime.rs`, `app/ui/src/index.css`
       and `app/shell/probe-matrix.js` into modules / partials by area, no behaviour change (the full player suite and the
       full UI matrix green before and after, the same cell list), and trim comments that only restate the code
       (`.claude/rules/writing-rules.md` § Code comments).

11. [ ] (owner's night of choice, real session) Rerun `src/player/tests/onmachine/scenes.sh crash` on a quiet
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

12. [ ] (owner) Pick the sidebar's presets row look: A (built: the creator row's look, "Made for this scene", a
       sliding chevron), B (three fanned preset thumbnails leading, "2 presets made for this scene") or C (an accent
       left edge, a tinted glyph and a count pill). Mock-up screenshots: the night notes of 2026-11-27.

13. [ ] A looping video's sound loses one graph quantum (64 samples of exact silence, 1.3 ms at 48 kHz) at every
       loop wrap: the private sink's recording in `a_scene_workers_crash_never_drops_another_outputs_tone`'s first
       version (a 10 s clip) had one at 10.16 s and 20.16 s and nowhere else; plain mpv 0.41 (`--loop-file=inf
       --keep-open=yes`) does the same (65 samples per wrap, 3 s and 4 s 240 fps clips). Judge it on real content
       (an audible click on a tone; music likely hides it) and close it if mpv offers a gapless wrap.

14. [ ] probe-sidebar `lib:reflow` fails when run alone (`--only '^lib:reflow$'`), on lp-player as well as with the new
       sidebar motion, and passes inside the whole probe: at 1000×560 with Large cards and 24 extra items the right-click
       opens the sidebar but the grid keeps 5 columns ("the cell proves nothing"), so the card-stays-in-view check never
       runs. Find what the earlier cells set up that it relies on (the card size, the window) and make it stand alone.

15. [ ] The suites without a network namespace (the UI matrix, the adapter IT, the settings suites,
       `test-steam-signin.sh`, `test-steam-app-hold.sh`) guard only the backend's own connections
       (`LIASCAPE_TEST_NO_NETWORK`); Electron, ffmpeg and the player in them can still reach the real network and its
       DNS. Run them inside `scripts/test-netns.sh` too (the matrix's private Xvfb, audio server and CDP ports all live
       on loopback), or show that nothing but the guarded backend could look a name up.

## Ready-to-do backlog (owner, 2026-11-16: next after Queued; each gets a short brainstorm before it starts)
- [ ] **Packaging**: `scripts/PKGBUILD` (`liascape-git`) builds clean on Arch (`makechrootpkg -c`), `namcap` is clean but
      for accepted warnings, and the package passed an install test as a throwaway user. Left:
      - [ ] Publish `liascape-git` to the AUR (first drop `zlib` from its depends if still nothing links it: `namcap`
            flags it).
      - [ ] An AppImage that runs where mpv / FFmpeg aren't installed: `scripts/build-appimage.sh` packs install.sh's
            staged tree and its own Electron but links the build machine's libraries. Build on an old glibc (an Ubuntu
            22.04 container); bundle libmpv and its FFmpeg, libplacebo, libass, SDL2, harfbuzz/freetype, lz4,
            libxkbcommon and static `ffmpeg`/`ffprobe`; take glibc, GL/EGL/Vulkan (glvnd), libwayland,
            PipeWire/libpulse, libva, fontconfig and libcuda from the host; give every bundled `.so` an `$ORIGIN`
            RUNPATH (no `LD_LIBRARY_PATH` in AppRun); pass `--no-sandbox` only when unprivileged user namespaces are
            off. Test with `ldd` on every ELF in containers without mpv/FFmpeg/SDL2.
- [ ] **Multi-monitor management** (per-monitor wallpapers, user-facing; none of it built): UI assignment, per-output
      rotation, which monitor actions target, `/current` + preview per output, `--restore`, hotplug defaults, and which
      screens are heard (v1 "First screen" / "All screens", later a sound priority list). Design (top-bar screen
      carousel, follow All, per-screen popover): `docs/superpowers/specs/2026-11-17-multi-monitor-design.md`; plan:
      `docs/superpowers/plans/2026-11-17-multi-monitor-v1.md`. Once outputs differ, a looping A shared on `align:end`
      must re-anchor its cached boundary (`target_end`) after a speed change at the next wrap.
- [ ] **Web wallpapers**: WE `web` items via CEF / LWE's `webhelper`, an optional build module, gated on the NVIDIA
      LINEAR-dmabuf external-only risk (`docs/player/architecture.md` § Not built). Once it plays, take Web out of
      `WorkshopTags.Unplayable` and the Browse type filter. The same web player serves Lively's web wallpapers (next).
- [ ] **More wallpaper sources** (owner: support all of them): first one source interface (search, page, details,
      download, filters/sort) that Browse, the sidebar and the download queue use, with the MoeWalls / MotionBGs /
      DesktopHut scrapers (`src/backend/Scrapers/`) moved onto it and sources switched on/off in Settings; then Wallhaven
      (stills, keyless for SFW, 45 calls/min) and Pexels Videos (the user's own free key, never one in the repo; its
      "Photos provided by Pexels" link required). Skipped as redundant: Pixabay, Unsplash, Wallpaper Waifu,
      MyLiveWallpapers (a ring of look-alike clone domains), Alpha Coders, Coverr. Once the interface lands, compare the
      three scraped sites' top 100 for duplicates and drop one that adds little.
      UI (owner's idea): ONE Browse view, no source pills — a Sources section heads the filter column (a checkbox per
      enabled source with its result count, click a name to show only it, a key mark linking to Settings); results merge
      into one grid, each card badged with its source, each source streaming in on its own (a slow or failing one shows a
      warning by its checkbox, never blocks the grid). Source-only filters sit in a section titled with the source.
      Sort: Newest merges by date; Popular interleaves. Defaults: only sources that need no setup; a keyed source starts
      unchecked and asks for its key in place when checked, never on first launch.
- [ ] **Quick switcher** (owner): a keybind (`liascape switcher` for the compositor to bind) opens a stylized popup of
      wallpapers to switch to, for people who don't run a timer or a playlist. Arrow keys / mouse pick, Enter applies (to
      the screen it was opened on, or All: the multi-monitor rules), Esc closes; works with the app closed, so a
      layer-shell overlay (the player or a small window), not the main Electron window. Brainstorm first: what it lists
      (recent, favourites, the playlist, search) and its look.
- [ ] **The logo in the app** (owner): the window's opening shows it (`components/Intro.tsx`), the app itself nowhere
      else. Show it where a logo belongs: the top bar or sidebar header, an About panel, the welcome / empty-library
      screen (`components/Welcome.tsx`). Night is `app/ui/public/favicon.svg`, Lavender `app/icon/liascape-lavender.svg`
      (both from `app/icon/generate.py`); the in-app logo follows the theme once light themes exist (Lavender on light,
      Night on dark). The installed icon stays Night: launchers cache it and Wayland takes it from the desktop entry.
- [ ] **A tray icon** (owner): a StatusNotifierItem with the controls on right-click (play / pause, next, previous,
      mute and volume, the playlist on/off and which one, recent wallpapers, open Liascape, quit) and left-click opening
      the app. It must cost next to nothing with the window closed: not Electron's `Tray` (it keeps the 100+ MB main
      process alive) but a small native helper speaking SNI + dbusmenu, driving the backend's API / `liascape ctl`,
      idle on D-Bus (it listens for the backend's change events), with a setting to turn it off. Icon may follow the
      system's light / dark preference. Check how Hyprland bars (waybar, DMS, noctalia) render SNI menus first.

## On a real desktop session (not hermetic)
- [ ] The night runs `programs.sh crash` and the 8 h soak (`scenes.sh soak --minutes 480`); `scenes.sh crash` is its
      own Queued item. A regression they find is a bug to fix; frozen-onset micro-gaps (2–10 ms) don't count unless the
      owner hears them.
- [ ] Seam probe at start-up: the on-machine `scenes.sh` reports 0 start-up seam frames now that a restored layer waits
      for its source's `Ready` (hermetic guard: `src/player/tests/api.rs` `restore_waits_for_ready_no_seam`).
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
- [ ] Draft PRs offering the LWE fork's patches upstream (Almamu/linux-wallpaperengine), several small focused ones,
      AI assistance disclosed. Drafts only: opening them publishes under the owner's name, so the owner approves each.

## UI
- [ ] A full 6-shard UI matrix fails three cells in shard 3, the same way with or without the network namespace:
      `idle × load:afterApply:wsLate` and `single × load:duringRestart` (the page's held `/current` never comes back:
      "proved nothing") and `single × clip:shortToFull` (the stand-in never played). All three pass alone
      (`--only`). Find what shard 3's earlier cells leave behind that these depend on, and make them stand alone.
- [ ] A matrix cell that hangs: twice a shard's probe sat in one cell (`scene × sceneProp:restart` for 30 min; 90 min
      after `single × pause:appBg`, next in order `single × load:duringRestart`, ignoring SIGTERM), neither reproduced
      alone. The runner now names a hung cell as an ERROR with its last phase and log lines: read that the next time it
      fires. The probe's own waits still have no timeout: `http()` on the backend, `js()` on the page, `ctlClient`'s
      `connect()` (its timeout starts only after the connection).
- [ ] The other probes (`--probe probe-sidebar.js`, `probe-steam.js`, …) and the matrix's fuzz steps have no per-cell
      limit: only the run's ceiling (5400 s for another probe) ends a hung cell there. Give their loops the heartbeat
      probe-matrix.js writes (`LIASCAPE_MATRIX_CELL_FILE`, `LIASCAPE_MATRIX_RESUME_AFTER`) so `test-ui-matrix.sh` names
      and skips the cell. Guard: a hang test cell per probe in `scripts/test-matrix-watchdog.sh`.
- [ ] Probe cells out of step with today's app: `probe-sidebar lib:preset:needsBase` / `needsBaseOff` expect a plain
      Workshop download disabled under "subscribe" while signed out, but since the two download modes (`actionBlocked`)
      only the one-off is blocked and a signed-out subscribe opens the item's page: update them to the modes' order.
      `probe-steam ws:comment*` assume a window short enough for the comments to start below the fold (pass at 480 px,
      fail on a taller one: size the window in the cell); `probe-steam steam:sub:keepMenu` fails about one full run in
      two.
- [ ] An item trashed outside this page (`POST /library/trash` from another window or client) never reaches an open
      page: `AppOps.Trash` (`src/backend/Web/AppOps.cs`) broadcasts nothing, so the Library keeps the card and the live
      background (`components/WallpaperBg.tsx`) a removed video until the next library read. Broadcast `library-synced`
      on a trash and an undo. Guard: probe-settings `bg:removed` with the trash posted by the probe.
- [ ] A first `/library` read that fails leaves the Library blank until a later read (`libraryRead` stays false,
      `store/index.ts`; the welcome and empty states wait on it): show an error with Retry there instead.
- [ ] probe-steam `ws:favoriteSteam` fails on lp-player's own UI, alone and in the whole probe: "the pill moved or
      resized as its state landed: [182,0,53,25]" (its `Off` variant passes). probe-icons `icon:centre:filters` failed
      once in the whole probe ("button.wf-seg.e[Hide Favourites] hover: the glyph is off its chip's centre by (-2.83,
      -0.47)") and passes alone: a hover read mid-motion; find what an earlier cell leaves.
- [ ] probe-filters `search:keep` fails inside the whole probe and passes alone: "840 px, room: after a blur holding
      "k1" it is folded reading "k1" (want open)". An earlier cell leaves something that takes the status slot's room (a
      wallpaper playing, the bar's width); make the cell set up its own state.
- [ ] Text that changes in place pops, against design.md's "content changes slide or cross-fade … numbers and bars
      ease" (only `components/SideTitle.tsx` does it). Add two shared primitives in `components/`: a `SwapText` (keyed on
      the value: the old line leaves and the new arrives with a short slide or cross-fade, width morphing on the soft
      spring; `no-motion` = a cross-fade) and an `EaseNumber` (counts roll or ease; `no-motion` = instant). Then convert
      status lines and counts, the playlist bar's now-playing, sidebar facts on an item switch, setting values, button
      labels that change state; never text being typed or selected. Guard: a probe cell per primitive (per-frame
      in-between states) plus one per converted area.
- [ ] Make Knip (`npx knip@5` in `app/ui`) a check: 23 unused exports when last counted (e.g. `SIDE_SLIDE_MS`,
      `useFilterDocked`, `presetsUsing`, `locateFx`). Per export: drop `export` when only its own file uses it, delete it
      when nothing does (a probe reading it through the page counts as a use). Then add Knip as a devDependency with a
      `knip.json` and a `scripts/check-*` hook so new dead exports fail.
- [ ] A failure recorder for the UI matrix: when a cell fails, `app/shell/cdp.js` saves the last ~20 actions (clicks,
      typing, waits, with timings), the console and failed network requests since the cell began, a screenshot and the
      DOM, next to the cell's log. Cheaper than porting the probes to Playwright for the part of its trace viewer that
      matters; new probes may still use Playwright over CDP if it proves itself.
- [ ] UI matrix fuzz: `playlistBarDrag:lastToSecond` fails "a switch was requested" (a playlist-bar drag of the last
      item to second asks the player to switch). Replay: `scripts/test-ui-matrix.sh --fuzz-replay 'pending:seq:itemSpdDrag+next:shown,itemVolReset:other,seq:plTrEffect+next,itemVolDrag:other,seq3:playlistBarRemove+trashUndo+next,playlistBarVol:off,seq5:playlistBarDrag+next+pause+resume+next,playlistBarDrag:lastToSecond'`.
      Find whether the drag really switches (a product bug) or the cell misreads a switch an earlier step queued.
- [ ] The UI × player-state matrix doesn't cover yet: auto-mute's "Only mute for media players" (needs a private
      dbus-daemon + a fake MPRIS player), Settings → Clear settings and Debug mode, a shuffle with advance-on-end (12
      plays of ≥ 10 s clips is too slow for a cell), deleting a saved playlist (no UI for it), per-monitor content.
- [ ] The macro feature = the rules system: triggers → actions with exceptions, run inside the player (research in
      `docs/superpowers/specs/2026-10-29-rules-recon.md`). "A game is running" is one of its first triggers, not a
      separate setting: detection notes and the cases to compose with in
      `docs/superpowers/plans/2026-10-29-game-running-signal-DRAFT.md`; what it does (pause, mute, stop) is the user's
      rule, so no default to pick up front. Owner 2026-11-10: it should be general-purpose enough to build intricate
      setups the built-in triggers/actions can't express (scripting for advanced users is the escape hatch).

## liascape-player
- [ ] A PipeWire restart can wedge an mpv core for good (about 1 kill in 6 under load): the audio bus reconnects but
      that player's mpv stays stuck (found hardening `i7_bus_reconnects_after_pipewire_restart`). Find why the core
      wedges; then the test can detect it (a `sources {mpv: false}` probe skipping the synchronous mpv reads, an
      `audio_device` probe field) and rerun.
- [ ] Rename the rotation's code identifiers to the UI's labels (`IntervalSeconds` in `Models/CustomPlaylist.cs` and
      the settings → switch-every / minimum play time, …).
- [ ] Explicit sync back on NVIDIA once egl-wayland2 > 1.0.2 ships: 1.0.2 leaks one queued `wl_buffer.release` per
      present with explicit sync (upstream fix 6235dd8, unreleased), so `serve` defaults `__NV_DISABLE_EXPLICIT_SYNC=1`
      and drains libwayland's default queue every iteration. With a fixed driver drop the env default, keep the drain
      (`docs/player/modules/wayland.md` § NVIDIA: explicit sync and the default queue).
- [ ] Slow IO against the player's own deadlines. Recipe, under `scripts/test-lock.sh` on a quiet night: 2 writers
      `while :; do dd if=/dev/zero of=<scratch>/io-N.bin bs=1M count=256 conv=fsync,notrunc status=none; done`, plus
      `posix_fadvise(DONTNEED)` every 3 s on the debug `liascape-scene-worker` (own `CARGO_TARGET_DIR`) and every
      library `ldd` lists for it (IO pressure `some` avg10 40–60 %). With the come-up waits start-aware
      (`tests/common/come_up.rs`), the last run still failed transition 1–3 of 32, supervise 2–5 of 21, program 4 of 73,
      each slow IO against a product deadline: `align_end_video_a_to_scene_b` (B's cold start must land in A's last 3 s),
      `scene_b_broken_mid_effect_snaps_back`, `cancel_waiting_restores_a`, `crash_restores` (the 1.5 s
      `RESTART_BUDGET`), `clean_quit_not_restarted` (the final snapshot's fsync),
      `fourth_restart_in_a_minute_starts_without_program`,
      `spare_worker_dies_with_the_player_and_returns_after_the_restore`, `program_survives_a_crash` (once also an
      unexplained post-crash "program idle, item 0 from 0"), program.rs's stepped "no frame within 2 s",
      `vram_stopped_scene_advances_without_broken_flag`. Decide per deadline: widen it under IO pressure or accept it.
      A product bug seen there: the snapshot lagged a switch by 2.4 s (fsync on a busy disk), so a supervised restart
      brought back the previous wallpaper (the backend's reapply restores settings, never the wallpaper). Seen once
      each under a busy desktop, never unloaded: `stepped_align_end_reveal`, `bus_down_falls_back_to_default_device`.
- [ ] Not ported (C6 decode): WE's `g_PointerPositionLast` starts at 0 0, so a freshly loaded scene's first frame sees a
      move from the top-left corner to the cursor; ours places the first position as a jump (fork patch 0106). Single
      frame, likely invisible: check against a WE reference before porting.
- [ ] Desktop pointer on Sway and other compositors: only Hyprland gives a global cursor (`signal/cursor.rs`; Sway's
      IPC has none), so elsewhere a scene sees only the pointer over its own surface.
## Backend structure
- [ ] One source of truth for the player's command API: the C# adapter's request/result/event types
      (`src/backend/Player/`) are hand-written copies of `src/player/src/api/` shapes; a renamed field only shows up
      when the adapter integration test happens to exercise it. Derive a JSON Schema from the Rust types (`schemars`),
      commit it, and add a test that checks it is current and that every C# DTO field exists in it with a matching
      type (or generate the C# types from it). Same idea later for the UI's `api/client.ts` vs the backend's web API.
- [ ] The shared HttpClient (`src/backend/HttpClientProvider.cs`: the scrapers' pages, the sites' downloads,
      steamcommunity.com) follows a site's redirects to any address, this machine and the LAN included. Give its
      connect the image proxy's public-address check (`ApiSecurity.PublicOnlyHttp`), with a test switch for the
      loopback fakes every hermetic suite points it at.
- [ ] Code comments cite closed TODO items by name (`TODO F5`, `TODO F6`, `TODO F7`, `TODO "Reaper trim at shutdown"`,
      `TODO "No explicit cap on concurrent lia-open worker threads"`, `docs/TODO.md "Offline scene loudness →
      integration"`, … in `src/player/src/` and `src/backend/Player/`): rewrite each to say why the code is so, or link
      the `docs/player/modules/` page or guard test that holds it (`.claude/rules/writing-rules.md` § Code comments).

## Older backlog
- [ ] `scripts/test-backend-stop.sh` § libop flakes on its "proved nothing" guard ("libop: an encode runs … got no"):
      the High clip of a 60 s 1080p fixture encodes in ~2 s, and the four `/clip?info=1` calls before the `pgrep` check
      can outlast it. Make the fixtures' encode outlast the requests (longer or larger fixtures, or check after the
      first request), not a longer wait.
- [ ] `scripts/lwe.sh --nix` loses the caller's `LIASCAPE_LWE_CORE_DIR`: the devShell sets it to the store core, so
      `build` tries to install into the read-only store. Workaround: `nix develop -c env LIASCAPE_LWE_CORE_DIR=<dir>
      bash scripts/lwe.sh build …`. Fix: carry the caller's value (or the `build/lwe-core` default) across the re-exec.
- [ ] Scene A's sound warbles during a transition (owner, not always): when the outgoing A is a scene, the transition
      sometimes plays "loud quiet loud quiet", "like audio in reverse or some ghost". Not reproduced in 39 recorded
      transitions on a private PipeWire (quantum 64, every method and mode, A at 0.8–1.25×, the compositor SIGSTOPped
      mid-fade, the owner's own pairs): A's stream is the scene's own sound × the equal-power fade, to the dB. Not
      covered: a real output chain with filters, a real compositor stall of seconds. When it happens, note the time and
      whether A's sound or B's warbles (most of those A's had no sound at all, so it may be B's video fading in). Tools:
      `src/player/tests/onmachine/transition_audio/` (`rig.sh up`, `record.py`, `srccmp.py`, `afade.py`, `sine.py`).
- [ ] Optional: a backend instance id in a WS hello (the page could tell a restart from a dropped socket). Not needed
      while every reopen re-reads; only worth it if `resync` ever gets expensive.

## Follow-up projects (each gets its own brainstorm)
- [ ] **Experimental: render a scene with real Wallpaper Engine** (owner, 2026-11-06: "maybe as a future experimental
      feature"; after the port, not instead of it): an opt-in per-scene backend that runs WE itself under Proton and
      imports its frames as a graph source (dmabuf, like the scene worker), for scenes the port still gets wrong. Borrow
      wallpiper's Vulkan dmabuf capture layer and `GetCursorPos` / Progman shim, not its daemon
      (`docs/player/spikes/wallpiper-ref.md`); the reference-capture setup (`scripts/dev/we-ref-capture.sh`,
      `docs/player/spikes/we-proton.md`) is its first half; Steam is not needed. Open: cost per instance, bridging
      pause / transitions / audio bus / pointer / properties / per-monitor, a clean WE install.
- [ ] **Deferred (owner, 2026-10-29: "overengineering at this time"): the app's background vs the desktop for scenes**
      — `WallpaperBg` can only play a video, so with a scene on the desktop the app shows the last video / a random one.
      Options: a transparent Electron window over the real desktop, or the player streaming its output frames to the
      UI. A gif preview was rejected (360p).
- [ ] **Lively Wallpaper wallpapers** (owner): import Lively's shared packages (a `.zip` or folder with `LivelyInfo.json`
      at its root) through Import and the folder import (`Helpers/FolderScanner.cs`); no Browse source (Lively has no
      central catalogue). Video / gif / stream types play with what exists; the web type needs the web player above,
      mapping `LivelyProperties.json` onto the properties editor and calling the page's `livelyPropertyListener` (later
      `livelyAudioListener`). Application type (Unity / Godot / .exe) not planned, as for WE. Lively is GPL-3.0: only its
      LivelyInfo / LivelyProperties C# models + parsing fit (notices kept, a row in UPSTREAM.md / CREDITS.md). Format
      docs: the project's GitHub wiki (lively-community/lively).
- [ ] The compositor's CPU per scene worker mid-transition: `scenes.sh workers` on the real outputs of a quiet machine
      against the 0.6 % per-worker bound (it passed 2/2 only on a loaded machine, where CPU % is noise). If it fails, the
      next lever is one release fence reused for every slot not sampled since it was made.
- [ ] The item sidebar's open / close glide costs main-thread frames: `node scripts/bench-live-ui.mjs sidebar` went from
      overBudget ~85 / over2Frames ~48 before the full slide to ~93–155 / ~49–86 with it (±30 spread). The long tasks are
      main frames while ~40 cards glide on `translate` / `scale` (`components/sideMotion.ts` playGrid): paint + layerize
      ≈ 7 ms each and IntersectionObserver work for the moving cards. Find what schedules a main frame per animation
      frame and cut it; measure before / after on the same bench, several runs each.
- [ ] Intel GPUs have no VRAM total (`src/player/src/vram.rs` `DrmProbe` needs AMD's `mem_info_vram_total`), so the
      per-scene VRAM limit and the low-VRAM rule never act there.
- [ ] "Pause behind windows" has only the pause action; Wallpaper Engine's "Mute" and "Stop" variants aren't built.
- [ ] Auto-mute cases never tested: a new stream under full CPU saturation (the harness only, lagged by `lia-sysmon`),
      MPRIS through the backend with a Playing player, a Flatpak player. A player without the capability has no
      auto-mute with the app closed (accepted).
- [ ] Tick a scene from the frame callbacks / the exact refresh instead of a rounded-Hz grid, so a scene at
      `scene_fps` = the refresh never beats against the vblank (the presents follow the callbacks, the content clock
      doesn't).
- [ ] An async dmabuf import (Phase 3 finding F5, `runtime::driver_call`): `eglCreateImage` on a helper thread with the
      ring's frames deferred until it lands, so NVIDIA's global driver lock (0.2–4 ms per slot) stops stalling the loop
      on a scene's create / resize; `glEGLImageTargetTexture2DOES` stays on the loop.
- [ ] The command queue's stall breaker tripped 6× in ~25 min of `src/player/tests/onmachine/speedstorm.py` while every
      verb answered in < 3 ms; not reproduced in a 25 min re-run. The next trip: read its `no reply to … (waited …; gen2
      GCs …, thread-pool queue …)` log line first.
- [ ] Missed frames scale with content fps (render worker): 2× ±0.05 every 90 ms → 0.65/s on a 240 Hz output, random
      0.25–4× (up to 240 fps content) 1–1.4/s against 0.16/s at 1×; what's left is the loop's own compose / present.
- [ ] **Scene compatibility leftovers**, beside the Queued item "Scenes checked against real Wallpaper Engine" (which
      works down every row of `docs/player/spikes/we-lwe-gap-audit.md`). Each is a fork patch; rerun the corpus, compare
      and health runners after each (UPSTREAM.md).
      - Upstream PRs to import as labelled patches: #631 (binary parser hardening), #694 (PulseAudio capture-stream leak).
      - Single scenes: 3042492564's clock shows a faint dark rim where its `shine` rays raise the alpha (WE's
        `BlendGlow` keeps it light); 3243449890's compose layer 16613, named in `dependencies`, needs WE's flag 0x1010
        (no WE reference yet); a flag-0x100 image layer gets no last draw; `auto_sway` (3235948233, 3414858021):
        hoisting `M_PI` builds it but the left cloth vanishes; 2325974975's buttons now that hit tests reach text
        layers; random particles / shafts / text (3490034653, 3478602089, 2561227934, 3363252053, 2511663284,
        2951169110); the degraded scenes in `docs/player/reports/scene-health.md`.
      - The 0.5 s reference frames of parallax scenes (3233141951, 3219908811, 3363252053, 3354740764, 2951169110,
        3289734539): WE's pointer arrives late in the capture; nudge earlier, or take that frame from wallpiper.
      - Owner's call: WE's cursor ripple (3184155462) scales with the frame time, weak at WE's 240 fps on Windows and
        strong at Liascape's 15 fps default; offer WE's fps presets or a per-scene "match WE fps"?
      - WE captures (Windows) to confirm decoded / inferred parts: clocks 1884904087, 2134765860; blend modes
        2883756643, 3414858021 / 3432999904; particles 3174556087, 2288455459 and an oscillating scene; puppets
        3463520581 or 3233141951; the three 3D scenes; the camera zoom direction (3516174947 letterboxed at "Lens size"
        0.75).
      - Not ported (0 library users unless named): 3D — directional shadow cascades, light clusters, PCSS, `lightconfig`,
        the `shadows` / `volumetrics` quality settings, volumetrics with SHADOW / COOKIE / fog and directional ones,
        REFLECTION, PBR-mask combos, fog on image / particle shaders, the 3D camera's zoom / parallax, customsortorder,
        text `depthtest`, hit tests of world-placed layers, an output-sized 3D target, a 3D CursorEvent's
        `worldPosition` and WE's type-5 hit branch; HDR displays' `combine_dhdr_upsample` and `combine_video_hdr`;
        puppets and models — bone physics (+ applyBonePhysicsImpulse, gravity / wind), root motion, IK limits (`ikce`,
        `ikrmin/max`), MORPHING_MODIFIERS, IModelLayer's animation-layer API, `perspective` model layers, MDLA v6's
        per-bone track, the scripted layer API (`getAnimationLayer`, `playSingleAnimation`), puppet hit boxes /
        CursorEvent.hitBox, static meshes keeping normals / tangents; particles — the `layerimage` emitter,
        collisionmodel, P24–P27, `controlpointangle0-7`, vortex_v2, the inferred F6 parts (boids, remap shapes, the
        initializers' runtime); a camera object's own `path` / `queuemode`; ITextLayer writes,
        IEffectLayer.transformAttachmentToTexture, .tex flag 64, flag 4's reader (`rad2deg` shader constants).

