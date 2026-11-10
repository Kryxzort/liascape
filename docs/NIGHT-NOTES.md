# Night notes — things the owner should know (newest last)

Read this when the owner asks "anything I should know". Append during unattended runs; never ask questions then.

## 2026-10-28 evening (before the owner slept)
- Pushed `598a727`: settings morph 720 ms open / 560 ms close (tune `SETTINGS_MORPH` in
  `app/ui/src/components/morph.ts`); the card's sharp image + preview video load at the click again; **NVIDIA now
  defaults to hardware GPU** (ANGLE `gles-egl`) — `LP_SOFTGL=1 livepaper-ui` brings back the old software path if the
  window ever misbehaves.
- Queue for the night, in order: rotation redesign (agent running) → Liascape rename + code-to-UI names
  (`docs/superpowers/plans/2026-10-28-liascape-rename.md`) → one-off migration of the owner's config/library (backup
  first) → branch cleanup → Phase 2 Task 14 (on-machine battery) → anything else worthwhile.
- No redirect needed from the old repo name (owner).
- Merged + pushed the rotation redesign (`989ea5a`) and loudness refinement (merged locally, push after checks).
  Your rotation answer → a follow-up agent: 0 = off for min AND max (max off = a 10 h video plays to its end; min off =
  switch at every end), plus a **"Separate timing for scenes"** toggle with one "Switch scenes after" field (a scene
  never ends, so min/max make no sense for it). Your config migration will keep today's behaviour exactly: min 0,
  scenes switch after your 20 s.
- Pushed the loudness refinement (`aeb0dea`) and the player hygiene batch (`17d8fbe`). The long-red
  `transport_meets_the_spike_budget` is settled: the worker's work per frame is constant; the CPU % swung with the core
  type / clocks / memory contention. A soundless scene no longer runs an idle audio thread; screenshots no longer stall
  the player (810 ms → < 1 ms); a VRAM-stopped scene frees all but its shown buffer. **First fully green crate suite in
  both render modes in two days.**
- LWE: upstream's new fixes landed on `main`, not `next-v2` (ours). An agent is porting the relevant ones onto your
  fork's `livepaper/next-v2` (fast-forward push only) and re-running the scene corpus.
- Pushed the scene-timing follow-up (`c4923c8`): 0 = off for min/max, "Separate timing for scenes" + "Switch scenes
  after". **Your rotation config is migrated** (backup: `~/livepaper-backup-20261028-2247`): your playlists with
  advance+wait (`dp`, `Full?`, the active one) → min off, max off, scenes after 20 s = exactly today's behaviour;
  `gg` keeps 3660 s as the maximum; the globals and `ds` stay plain timers. I stopped/started the dev backend unit for
  it (your wallpaper may have gone blank for a moment). Press Ctrl+R in the app before changing settings.
- Found by the rotation agent: an fps cap (VideoFpsCap > 0) stopped still images from ever showing — an agent is fixing it.
- **LWE fixes ported: scene corpus 86/96 → 92/96 ok** (`3cb7797`, fork `livepaper/next-v2` fast-forwarded to
  `bab619b`). 8 of upstream main's 13 new commits ported (text `padding` as a string, the `"particle": null` crash on
  clock text — that was the "leaf particle" segfault —, a script leak, effect sizing, …), plus 3 small patches of our own
  (a wrong-typed JSON field no longer aborts the process, case-insensitive asset lookup fallback, an effect that can't
  compile is left out instead of blacking out its object). Still not ok: 3 3D scenes (LWE has no 3D) + 1 still image by
  design. The live player picks it up on its next upgrade (release rebuilt).
- Pushed the fps-cap fix (`e9eaf0f`): an fps cap never reaches a still image any more (mpv's `fps` filter swallowed
  the image's single frame). Found meanwhile: a race where re-opening the same scene right after a stop can seed it
  with the previous loudness measurement (loses a few seconds of measurement, intermittent IT check) — in TODO, after
  the rename.
- Running: **Task 14 battery on your real monitors** (it stops the dev backend while it runs and starts it again at
  the end; your wallpaper is not re-applied) and the **Liascape rename** (merged only after the battery).
- **Liascape rename is built** (7 commits, not merged yet — it lands right after the battery so the two don't
  collide). One `liascape` command: no argument = the app, `liascape next|previous|toggle-mute|toggle-pause|toggle-play|
  restore|random|kill|volume up|volume down`, `liascape ctl …` = the player. Settings keys now match their UI labels
  (e.g. `VideoFps` → `VideoFpsCap`, `AdvanceOnVideoEnd` → `SwitchWhenVideoEnds`, `LweMonitors` → `SceneMonitors`).
  Checks: crate 498/498 in both render modes, adapter IT 264/266 (the 2 = the known loudness reseed race), settings
  merge 72/72, UI matrix 780 pass / 29 skip / 0 fail, `nix build .#liascape` ok. A one-off migration script copies
  your config/library to `~/.config/liascape` etc. (never touches the old dirs) — tested on a copy of your data: 315
  library items, 2 scene monitors, the 219-item playlist all came through.
- **Your Stop hook (`~/.local/bin/livepaper-post-hook.sh`) kills every Electron whose args contain `/app/shell`**
  — including the test matrix's headless windows from the agents' worktrees (it was the cause of tonight's mystery
  matrix hangs). It fires whenever `livepaper-watch` is inactive and the source changed. Worth narrowing it to your
  installed app's path, or skipping it while a test runs. After the rename it also needs the new names
  (`liascape-watch.service`, `~/.cache/liascape`, `liascape`, the backend now runs as `liascape-backend serve`).

## 2026-10-29 night — Phase 2 Task 14 (scene-worker on-machine battery)
- **Report: `docs/player/reports/phase2.md`.** Crash isolation, pause on a scripted scene and the 1 h soak PASS
  (soak 0.17 MiB/min, VRAM per worker flat, 116 switches all done); dropout matrix 720 switches, **0 drops**, one 3 ms
  micro-gap left (frozen scene→scene at 240 Hz, open); pacing 6.94 / 4.17 ms on DP-1 / DP-2 with scenes at the refresh.
- **Five fixes, each with a test:** scenes at `scene_fps 0` used to miss every few vblanks (now paced by frame
  callbacks); the dropout detector's false drops on late ramp edges + meter gaps; the bus meter on the real-time
  thread; the GPU budget now sees every monitor's missed frames; the compositor no longer rewrites unchanged source
  values every frame (CPU per scene worker 2.9 % → 0.1 %).
- **Open (docs/TODO.md → "Phase 2 battery findings"):** heavy real scenes cost 7–26 % CPU in their worker (same as
  LWE itself per frame), a very GPU-heavy scene can still cost your 240 Hz monitor frames, CPU mid-transition.
- **Scene corpus vs legacy:** nothing that plays under legacy fails under lp-player; 37 scenes play only under
  lp-player (legacy crashes or shows black on them).
- **For you:** the VT-switch / suspend check (`phase2.md` § 8) — listed under "Waiting on owner".
- Your wallpaper was taken over for the runs (blank between them); `livepaper-watch` is started again at the end.

## 2026-10-29 morning
- **Liascape merged + pushed** (`0686ed9`); the GitHub repo is now `Kryxzort/liascape` (origin updated). Your data is
  migrated to `~/.config/liascape` etc. (old dirs untouched; tar backup `~/livepaper-backup-20261029-0542.tar`); the dev
  units are now `liascape-vite` / `liascape-watch` (the old ones disabled). Verified on the new backend: 315 library
  items, 2 scene monitors, the 219-item "Full?" playlist, engine `liascape-player`, every feature healthy.
- The Stop hook is off (owner). 37 merged agent branches + worktrees and 11 merged local branches removed.
- Your steps are on the on-screen todo (NixOS module + keybinds + the VT/suspend check).

## Night of 2026-10-29 → 30

Plan (owner: "do whatever you want tonight … continue with our project"; switch to Windows for WE screenshots tomorrow):
- LWE scene port, one batch at a time (they all patch the same fork branch): B1 property scripts (running), then B2 alpha/colour + keyframes, B3 particle core, B4 text, … per `docs/player/spikes/we-lwe-gap-audit.md`.
- F6b (compositor CPU per worker mid-transition, 2.45 % vs 0.6 % on-machine) — agent running.
- ≤ 2 big agents at once; model/effort chosen per agent.
- **Change of plan (owner, later that evening): "defer port for later, lets focus on the bigger picture".** The LWE
  port is PARKED after batch B1 (owner: "dont stop it, just let it complete and then leave it there"): B1
  (property scripts) finishes; B2+ wait. Instead: **Phase 3 implementation started** — Tasks 1–3 (pure rotation rules, the `program` node,
  the rotation engine), one agent, Opus high. F6b agent still running.
- **Owner, before sleeping:** max 2 agents at once tonight (the 3 running — F6b, Phase 3 T1–3, LWE B1 — finish
  naturally first); then run through the plans by priority. Order: Phase 3 T4 → T5 → T5b → T6 (revise the cover
  rule per the recon first) → T7 → … ; second slot: the offline loudness estimator's backend wiring (TODO design).
  Auto-mute (T14): latency must be ≤ today's p50/p95 (no 100 ms slack), and NO default exclusions (rules feature
  may default-exclude notifications only).
- **LWE B1 done** (`40b7402`, fork `8902c4a` pushed): property scripts run — init/update/applyUserProperties,
  thisLayer/thisObject, scale/angles/visible drive the layer; WE's own JS classes load at run time from the user's
  WE install (nothing copied). Also fixed: solid layers vanishing at random (uninitialised config). Corpus 92 ok,
  0 blank/broken/timeout (2 former timeouts now ok). Port now PARKED (B2+ wait).
- **Phase 3 Tasks 1–3 done** (`35bbba6`, `2da2ea0`, `838a708`): rotation rules, the `program` node, the rotation
  engine inside the player (timer, end-of-video with min/max, scene timing, failure ladder). 28 program tests.
  Not wired to the backend yet (Task 7). Next: Tasks 4, 5, 5b (agent running).
- **F6b fixed** (`93a4f8a`, `25808ab`, `8b95fcb`, `cce1154`, `e63cd00`): a wake updates only its own source,
  worker reads follow epoll, no wait on a signalled fence, no idle gain messages, schema built once. Syscalls per
  worker frame ~56 → ~29; headless excess instructions mid-fade 0.28 → 0.08–0.14 G/s. On your monitors: 2/2 under
  the 0.6 % bound (machine was busy — worth a quiet re-run: `scenes.sh workers`). Audio unchanged (onset harness).
- **Started:** the loudness estimator wiring (import + Settings → Audio "Scene loudness" Estimate / Recalculate
  all / Cancel, per-property-combination loudness, live re-seed on a property change).
- **Phase 3 Tasks 4, 5, 5b done** (`4b2f440`, `2081e19`, `0aae1ef`): user next/prev/random + live playlist edits
  (re-arm, never reset the countdown), programs survive player restarts (`program.json`, snapshot), "hold until a
  monitor returns" (`while_parked`), and the playlist "Start over / Resume where it left off" (player side).
  65 program tests. **Next: Task 6** (pause when covered) — with the cover rule revised to "visible", not "focused".
- **Fans (side request):** `/etc/nixos/fans.nix` adds the writable `nct6687d` driver + CoolerControl (uncommitted in
  /etc/nixos; the rebuild compiled the CachyOS kernel locally — same kernel). fan6 = the splitter with the rattling
  fan; nothing slowed (owner: "its quiet rn").
- **Scene loudness estimator wired in** (`5a9248f`, `dc7ddb2`, `d27f408`, `5b274e6`): estimates on import/sync/start
  (96 scenes in 9.8 s warm, 323 s cold, 0 errors), Settings → Playback under "Normalize audio": "Scene loudness"
  Estimate / Recalculate all / Cancel, the card info shows "≈ … (estimated)" / "(measured, N min)". Loudness is now
  stored per audio configuration — toggling a sound property (tested live on 2951169110's orchestral switch)
  re-keys, ramps the normalisation in 500 ms and continues that configuration's own measurement. A one-off script
  moved your 13 measured scenes to the new format (index backed up first). Adapter 281/0, UI matrix 780/0.
  ⚠ An older installed liascape (the NixOS one) writing the index would drop the new fields — reinstall/bump.
- **Next:** Phase 3 Task 7 (the backend hands rotation to the player program) — running beside Task 6.
- **Phase 3 Task 6 done** (`438d140`, `55f41c9`): pause-when-covered in the player. "Covered" = a fullscreen /
  maximized window is VISIBLE on the monitor (Hyprland: the monitor's active or open special workspace; Sway:
  `visible`; other wlroots: foreign-toplevel; GNOME/KDE: unavailable, never pauses) — focus plays no part. Every
  monitor showing the wallpaper must be covered for 300 ms; release at once. Checked on your Hyprland: both
  monitors read "none" (no fullscreen/maximized window was open) — a real covered pause is checked in Task 12.
  The setting/UI comes with Tasks 7/10.
- **Started:** Task 14's player side (in-player auto-mute, behind a flag) — owner's bars: latency ≤ today's, delay
  accuracy, 500 ms default, no default exclusions, MPRIS = the player's own streams. Backend switch-over after Task 7.

## 2026-10-31 night

- **Phase 3 Task 7 done** (`9969e65`, `d51a016`): rotation runs as the player's program `prog:main`. Your bar
  playlist "Full?" is rotating through it (left running). Local scene 3276522107 never loads — the program skips it.
  Adapter IT 314/0, UI matrix 778/2 (both load-only, pass alone).
- **Task 14 player side done** (`8b2609b`, `0757e86`, still behind `LIASCAPE_PLAYER_AUTOMUTE=1`): on an idle machine
  p50 mute 32 ms vs today's 53, a new stream 36 vs 79; a set delay lands within ~3 ms (today 32–47 ms late).
  Open: a 341 ms p95 tail for a brand-new stream at quantum 1024 with all cores saturated (cause unknown); CPU
  criterion 9 — 5 streams cost 23–45 ms/s in the player + 14–30 in the `parec`s it starts (+33–74 in pipewire-pulse):
  **your call** whether the criterion counts the helpers. Not yet tried on your real session / a real browser.
- **Task 8 done** (`e2e3db1`): under liascape-player no timer/restart daemon, pid file, `pending_action.txt` or
  `timed_state.json` is ever written; `liascape restore` starts the player with `--restore --session-start`.
  Adapter IT 345/0. Only tested through a headless stand-in — a real boot/restore on your session is still Task 12's
  owner-run step. Decisions: `play` while a single wallpaper shows does nothing; a restored paused rotation stays paused.
- **Task 9 done** (`1cfa5fa`): the player keeps an outbox of crashes / loudness / VRAM stops while the app is closed;
  the backend stores them on its next start (37 ms after connecting). IT 353/0 merged.
- **Task 10 done** (`f8b90d6`): Settings → "Pause when covered" (default: fullscreen or maximized), "When the playlist
  starts again" (Start over / Resume, also per playlist), Advanced → "Show expert options" with the expert row "When no
  monitor shows the wallpaper". "Resume from last on launch" removed. Matrix 780/0, IT 363/0.
- **Task 11 done** (`d19d738`): 47 new UI-matrix cells, full matrix 827/0. Fixed 3 real bugs it found: a max-play
  switch could start under a pause (picture stayed on A while the UI said B); `previous` at the first item un-paused;
  Play on the playing playlist under Resume marked item 1. ⚠ One old fuzz sequence (playlist-bar drag + next on a
  2-item bar) fails on `lp-player` too — handed to Task 12 as optional.
- **Task 12 done** (`docs/player/reports/phase3.md`), on your real session, audio on a private PipeWire: 600 program
  switches 0 drops, 1 h app closed 118/118, 5 crashes all back at their item, 2 h soak 0.065 MiB/min. **Bug found and
  fixed:** with all monitors off Hyprland adds a fake `FALLBACK` output; the player counted it, so "Hold until a monitor
  returns" kept rotating. **Your calls:** the cover pause takes 374–401 ms against 350 (250 ms debounce, or a 400 ms
  bound?); "handoff ≤ 1 frame" passes as a clip frame (33 ms), fails as an output frame. Still yours: cold boot,
  suspend, VT switch (report § 6).
- **Task 13 done**, and the old fuzz failure is explained: the test's own (on a 2-item bar its "drag" was a click).
- Your wallpaper is off: you stopped it at 20:11:46 yesterday (the backend logged it), so I did not restart it.
- **Task 14, backend half merged, switch off** (`7081e59`): nothing changes for you until `AutoMuteParityPassed` is
  flipped. Tests on a private PipeWire, not your session: IT 389/0 off and 398/0 on, settings 104/0, matrix `autoMute`
  21/0 both ways. Added a player verb, `automute.release`, because no prop could lift a mute while the stream plays.
  **Still yours:** the ten criteria on your session (a real browser, `mpv`, Spotify) and CPU criterion 9, which only
  meets the bar if pipewire-pulse's cost is counted. A flaky stall test is logged as TODO F5; not caused by this.
- **From your noctalia list, three toggles** in Settings → Appearance: Glow effects, Morph animations, Autoplay video
  thumbnails (at most 4 play at once). Defaults keep today's look. Settings 131/0, IT 389/0. Full matrix 823 pass, 7
  failed under load and passed when rerun alone. The off states were checked by computed style, not by eye.
- **Three bugs from your noctalia list fixed:** a wallpaper started from nothing just appears (no fade from black); a
  right-click no longer stops an mp4 hover preview; under Shuffle the bar marks the item that really plays. Merged with
  the toggles: IT 389/0, player lib 325/0 and program 69/0, full matrix 834/0. TODO F6 filed (a timer firing early once).
- **Auto-mute now runs in the player** (Task 14 done): its Signal is on by default (`LIASCAPE_PLAYER_AUTOMUTE=0` turns
  it off), `monitor-daemon` is retired under liascape-player (a leftover one is stopped), no `pactl`/`parec` run. IT
  400/0 (389/0 with the old engine), settings 131/0, full matrix 834/0, cargo all ok. Your backend and player run it now.
- **F7 fixed:** "Start over" + shuffle no longer begins every boot on the same wallpaper (the shuffle's state is kept
  in the snapshot). **F6 fixed:** playing a playlist again no longer switches at once when its saved countdown came
  from other timing settings. **F5 partly:** the flaky stall test was mostly CPU contention (now measured as the
  player's own time); a rarer real ~3 ms block under GPU load is being traced tonight with bpftrace.
- Tonight (2026-11-02 → 03): one agent on F4 (`--debug` dropout probe causing silence), one on F5's open block.
- **F4 fixed:** `--debug`'s dropout analysis forked the whole player for each ffmpeg decode, and the fork cost the
  audio whole cycles of silence. It now spawns without forking. Battery re-run on your machine (your player was off
  ~50 min while you slept, then restored): 0 drops; the same 3 `frozen` micro-gap FAILs as before (handoff work).
- **F5 settled:** the rare real stall was the NVIDIA driver's global lock (other GPU processes allocating); our image
  frees now happen off the player's loop, imports are documented as a driver limit. 3 full suites green.
- **Phase 2 VT/suspend check done** (your player off ~3 min): a scene through a VT switch, a suspend and two suspends
  within a minute — no restart, never broken, PASS 12/12. The machine suspended 3 times around 23:48.
- **Health panel:** it now reports the player's PipeWire audio bus (down = a warning; audio then falls back to mpv's
  default device), and the playlist modal's Transitions field shows the same warning icon as Settings. IT 404/0.
- **Scenes, batch B2 (scene-engine fork patches 0022–0023, pin `d4969e4`, pushed to your fork):** layer alpha/colour
  reach the shader live and keyframe animations play (179 animated values in 26 scenes). Corpus ok 92 → 93, nothing
  newly broken; e.g. Kimi's clouds now blend instead of drawing as opaque puffs. Your player runs it. B3 (particles)
  is in progress.
- A 7 h headless soak (glibc free-heap question) runs until ~07:00.
- **The PC crashed ~01:10** (not ours; the journal just stops). It killed the soak and two agents; both were redone.
  Soak answer from the 95 min it ran: glibc's free heap is flat now (was +4.1 MiB/min) — no change needed.
- **Scenes, batch B3 (fork patches 0024–0028, pin `93438d4`):** particle systems behave like WE — prewarmed to their
  `starttime` (snow covers the screen at +1 s, not after a minute), one shared colour random, `count`/`rate` as WE
  means them, HSV tints, sprite-sheet cross-fades, live overrides. Corpus still 93 ok, nothing newly broken. Live.
- **Scene switch under load fixed:** on a busy machine a heavy scene could take 13–28 s to load and the switch to
  it failed at 10 s. A scene that is still loading (its worker still getting CPU) is now waited for up to 50 s
  while the old wallpaper plays on; a stuck load still fails/restarts. What's playing isn't slowed. Live.
- **Scenes, batch B5 (fork patch 0029, pin `9f64193`):** parallax follows the mouse the way WE does (delay
  smoothing — 14 of 25 parallax scenes were frozen), plus camera shake, `general.zoom` and camera-object zoom.
  Corpus unchanged (93 ok). **Please look at 3516174947** in WE vs here: its camera "Lens size" 0.75 now zooms
  its layers out (32 % black) per the decoded formula — a WE capture would settle whether that's right. Live.
- **Command-queue fix (backend):** a live speed storm on your session (wallpaper speed jumping ~03:59–04:25, audio
  muted, settings restored) filled the backend's player queue twice. Cause: setting 315 items' speed overrides in a
  row queued one un-mergeable command each, and the 256th dropped one (could be the playing item's speed). They now
  batch into one pass; a cap hit logs what was pending. The stall breaker never tripped in 25 min (still open).
- **Scenes, E41 (fork patch 0037, pin `d29b73c`):** an effect switched by a wallpaper setting (or by its script)
  now turns on and off live, the way WE does. Before, it changed only after a reload. 33 scenes have such
  switches, e.g. Bunk's "lights on", Retro Room's pulse, the "ts" overlay of 3163060610. On the 28 of them that
  load and draw, flipping a setting live gives the same frame as setting it before load. Not done: script
  `getEffect()` and the media-event scripts (batch B10).
- **Scenes, batch B10 (fork patches 0038–0044, pin `fd2fc72`):** wallpaper scripts now get most of Wallpaper
  Engine's API: clicks and hovers work (2325974975's "Mute/Time/Date/Hide/Bloom" buttons light up and "Hide" hides
  the text box), layers can be found by number, sounds can be played/paused from scripts, settings reach scripts
  when you change them, and scripts' saved data survives a restart (`~/.local/state/liascape/scene-storage`).
  **"Now playing" widgets** read your MPRIS player (whichever is playing; Spotify's cover is downloaded once with
  curl): e.g. 2134765860's shelf poster shows the album art. Script errors over 20 scripted scenes dropped from 867
  to 183; most of what's left is audio-reactive scripts (batch B8). 3414858021's date text now moves off-screen
  because text layers don't follow their parent yet (batch B4).

- **Scenes, batch B8 (fork patch 0045, pin `f383c4a`):** audio-reactive wallpapers now use Wallpaper Engine's own
  spectrum (decoded from wallpaper64.exe): its bands, smoothing and auto-gain, `engine.registerAudioBuffers` for
  scripts, and particle emitters whose rate follows the music. With a synthetic tone, 22 of the 39 audio scenes that
  load visibly react (2542468435, 3029971128, 2890767643, 1556245028 the most). Left and right are still the same:
  the player feeds one mono mix; stereo is a TODO. The agent doing this hit the weekly usage limit mid-way; the
  rest was finished in the main session.

- **Scenes, batch B7 (fork patches 0046–0047, pin `5a365d4`):** blend modes and compose layers now work the way
  Wallpaper Engine does them (decoded from wallpaper64.exe):
  - Layers that blend with the scene read a copy of it instead of the image they're drawing into.
  - "Add" (mode 31) is plain additive blending: 2883756643's bokeh and 3184155462 are brighter.
  - Effects no longer pull in the opposite edge of a layer (WE clamps by default).
  - Compose layers draw their child layers through their own effects: 3490034653's light shafts are now masked the
    way the author set them up.
  - A B8 bug was fixed on the way.
  - All 88 scenes that load still load, and frame time is unchanged. 3426575339, 3432876246 and 3556794116 render
    blank on every core, including the previous one, so that is a separate fault to look at.


- **The "blank" scenes weren't broken.** 3426575339, 3432876246 and 3556794116 were blank only in the test
  renderer (`--lwe-smoke`), and on every core going back to before E41, so nothing in B10/B8 broke them. Their
  picture is a video, which plays in real time, and the test ran 3 s of the scene in a fraction of a second, so the
  video never got its first frame. Your player was never affected. The test now runs in real time: all three
  render, and so do 3046119914 and 3432999904 (the two "black" ones). 93 of 96 scenes pass; the 3 left are the known
  3D scenes. Earlier test numbers for the 12 video scenes were taken with the video black.

- **Scenes, batch B4 (fork patches 0048–0050, pin `6bc301c`):** text in scenes now works the way Wallpaper Engine
  does it (decoded from wallpaper64.exe).
  - Clocks, dates, song titles and labels are drawn as image layers. They take their effects (glow, shake, tint),
    follow their parent, turn, and move with parallax. 3414858021's date block is back on screen.
  - They are sized as WE sizes them (300 dpi), wrap at their width limit, stop at their row limit with "…", align
    left/right/centre, and do multi-line and Chinese/accented text.
  - System fonts (`systemfont_arial` etc.) come through fontconfig. Here that's Arimo, Comic Neue and Inconsolata;
    before, the text vanished on NixOS.
  - Two bugs found on the way: a text of 2–4 words ("Sinner #8") vanished, and a colour setting written "1 1 1" was
    black (117 colour settings in your scenes are written that way; e.g. 2134765860's clock).
  - Compared with the sizes WE's editor saved, 44 of 50 texts match in height within 2 px.
  - Also re-checked B7's blend modes on 2883756643 now that its video shows: still right.

- **Scenes, batch B11 (fork patches 0051–0053, pin `a209070`):** particles now move the way Wallpaper Engine moves
  them (its particle operator code, decoded from wallpaper64.exe for the first time).
  - Fades, size and colour changes and flicker combine instead of overriding each other.
  - Drag, gravity, swirl (vortex), cursor attraction and turbulence use WE's formulas. Cursor attraction reaches
    twice as far as before and eases off near its edge.
  - **Child systems run**, which 29 of your scenes use: sparks and trails that follow particles, rain splashes
    where drops land, glows on embers. Before, they were missing entirely.
  - Box emitters with a speed now throw their particles outward; they used to sit still.
  - Particle "control points" take the positions the author set for them (birds' flight paths, lens flares), and
    cursor-following particles stay under the cursor in scaled or rotated systems.
  - All 93 scenes that load still load; none went blank. Frame time is unchanged (3.8 → 3.6 ms mean).
  - Not done yet (in TODO): rain splashes lying flat on the ground, rope/trail shader options, and WE captures
    of a couple of these scenes to check them against WE itself.


- **Scenes, batch B12 (fork patch 0054, pin `1eb795e`):** puppet characters (WE's "puppet warp") now move and fit
  together the way Wallpaper Engine does it. The loader for WE's puppet files was decoded from wallpaper64.exe.
  - All 14 puppet scenes load their meshes now. Before, 7 used a file version LWE refused, so they showed the flat
    sheet of parts.
  - The characters breathe, blink and sway with their animations. Layered animations (a base motion plus added
    breathing or blinking) mix the way WE mixes them.
  - Parts pinned to a bone stay on it. 3463520581's Asuna has her hair again (she was bald), and 3233141951's girl
    has her face back.
  - All 93 scenes that load still load; none went blank.
  - Not done yet (in TODO): a WE capture to check the poses against WE itself, and blend shapes, physics hair and
    bone fading, which a few scenes also use.

- **Scenes, batch B13 (fork patch 0055, pin `0d66ae8`, which also carries B12's 0054):** scenes marked HDR now
  render the way Wallpaper Engine does at its **Ultra** post-processing setting (decoded from wallpaper64.exe).
  - They draw into higher-precision buffers, so bright additive parts (sparks, snow, light) can go above white, and
    only those glow, through WE's own HDR bloom. Before, HDR scenes used the normal bloom with different settings:
    3395587987 was washed out all over; now its snow and highlights glow and the rest is crisp.
  - Effects that ask for a special buffer format get it (e.g. a 2-channel depth-of-field mask, half-float fluid
    buffers).
  - 4 of your scenes are HDR (2511663284, 2542468435, 3019192537, 3395587987). They cost about 1 ms more per frame.
  - All 93 scenes that load still load; none went blank.
  - One assumption: WE only does this at Ultra post-processing. If you run WE below Ultra, it shows these scenes
    with the normal bloom. `WPENGINE_HDR=0` gives that look here. A WE capture of 3395587987 at Ultra is on your list.

- **Scenes, batch B14 (fork patch 0056, pin `40f2b85`):** the 3 scenes that never loaded — Wallpaper Engine's 3D
  scenes — now load and play. LWE had no 3D at all.
  - 3276522107 (night metro car): looks like its preview — the inside of the car, the city passing in the windows,
    the girl on the right, rain and the camera sway.
  - 3477054430 (kitty on a rooftop): the 3D town, the moon, the stars and the kitty's head and body, lit by the
    scene's spot lights.
  - 3509243656 (space HUD): its texts fade in after 3.5 s, then the clock, date, logs and the Milky Way sky show. Its
    planet sphere stays black: the scene has no lights and the planet's glow map isn't hooked up yet.
  - The pin also carries batch B13 (HDR bloom). All 93 other scenes still load; none went blank.
  - Not done yet (in TODO): shadows, light cones you can see (volumetrics), the light-ray quads of 3319542538, and
    checking the three against Wallpaper Engine itself.

- **Handoff work (Wednesday job, 2026-11-04): the lost audio cycles and the cut last frame are fixed.**
  - **Audio — the single 64-frame cycle of silence at a handoff (F7 residual, Phase 3 F1, the 23 runs in your
    battery re-run) had one root cause**, caught with PipeWire's own profiler: when a wallpaper's audio stream
    left the bus (a scene worker quitting, mpv pausing or being torn down), PipeWire's client library marked the
    stream inactive before the server had stopped counting it, and a graph cycle starting in that window waited
    for it in vain — the whole graph skipped one cycle and the speakers got 1.3 ms of zeros. Every stream the
    player opens is now an *async* node (nobody waits for it inside a cycle). Before/after on 60 full-live
    scene switches (release, 240 Hz): 6–7 lost cycles → 0, in two runs each; a V→V test that lost a cycle 1 in 20
    now loses none. Cost: audio reaches the speakers 2.7 ms later (two graph hops at your 64-frame quantum),
    which the player compensates for mpv's lip sync.
  - **Picture — "handoff vs A's end" (F3) is now one output frame, not one clip frame.** A's last frame used to be
    cut 10–14 ms short (B drawn over it): the fade's end estimate subtracted half a clip frame "to centre an
    error" that was already within a tick. Aimed at the raw estimate, B takes over 0.7–7.3 ms after A's last frame
    has had its full 33 ms (6 switches at 144 Hz, real libmpv) — never before.
  - Still yours: a battery re-run on the real session (`programs.sh dropout` with `P3_RECORD`) to see the
    23 zero runs gone on your outputs.

- **3414858021 (the rainy-window girl) — your report, fixed (fork patches 0057–0060, pin `e814c25`).** None of it
  came from today's batches; it was broken from the start, as you said.
  - **The head:** the scene's "follow" scripts turn the body, head and arm by about a degree as the cursor moves.
    Wallpaper Engine's scripts work in degrees; LWE took them as radians, so the body turned 55° and the head (pinned
    to the body's neck) and the arm flew off the screen — the grey arch was the turned body. On top of that, the
    layer holding the head, eyes and hair (a compose layer with an eye-tracking and a depth effect) failed to
    compile on four things Wallpaper Engine's compiler accepts, so it wasn't drawn at all. Both fixed; the hard
    bright band across the lower part of the screen was a side effect of that broken layer and is gone too.
  - **The mouse trail:** it followed the pointer mirrored top-to-bottom (pointer down → trail up). Fixed; this
    affects every scene with a cursor trail.
  - Also fixed: script rotations in other scenes (a fan, audio bars, a loading spinner) now turn in degrees too.
  - Not done: the hair/cloth sway effect in this scene still doesn't run (making it compile made the left curtain
    vanish, so I left it off — in TODO); "WEDNESDAY" still touches the right edge.
  - Corpus 96/96 ok on both cores, none newly blank; host_api_test 71/71 (3 new, red before); player tests 740/0/3.

- **Shaders now compile the way Wallpaper Engine's do (fork patches 0063–0064, pin `cbdf2fb`).** I read how WE itself
  prepares its shaders (it turns them into Direct3D shaders and compiles them with Microsoft's compiler) and made LWE
  follow the same rules: include files land where the `#include` line is, the shader's declarations are visible to all
  of its code, the pixel stage sees the vertex stage's outputs with their real types, and Microsoft's looser rules
  (automatic conversions, scalar conditions, constants set from settings, …) are emulated. A new "shader sweep" compiles
  all of WE's own 124 shaders and the 272 custom ones in your library in every combination of their options without
  drawing: 313 failing compiles → 47, all explained (WE's shadow-casting shaders, which LWE doesn't use yet, and a few
  option combinations the shaders' authors left broken — WE can't build those either).
  - Scene health: **79 clean / 17 degraded** (was 75 / 21), none worse; no shader errors left — the rest are script
    APIs and two unsupported features. 3243449890 gets its audio ring and the triangle clock clips back, 3219908811 its
    blossom background, 2815800031 / 2469881470 the chromatic aberration, 3354740764 colour grading + tone mapping +
    CRT, 3432999904 its tone-mapped compose layer, 3414858021 / 3516174947 / 3243449890 the hair and cloth sway.
  - **3414858021: the left white cloth (左白巾) now sways and stays visible** — the earlier "it vanishes" was a bug in
    how LWE copied a value the shader modifies: the shader has three versions of its main function and only the first
    (unused) one got the copy.
## 2026-11-04 evening — Wallpaper Engine coverage audit + the SceneScript API

- **The master gap list: `docs/player/spikes/we-coverage.md`.** Everything Wallpaper Engine supports, item by item,
  against our fork: SceneScript (all 453 items of WE's official type definitions), scene / object / effect /
  material / model / particle keys (what the 96 library scenes and WE's stock assets use), blend modes, texture and
  FBO formats, object types, effect pass options. Each row: implemented / partial / missing, how many scenes use it,
  a size.
- **SceneScript: 329 → 421 of 453 implemented** (fork patches 0065–0070). Scripts can now create and destroy
  layers (the visualiser bars in 3 scenes, WE's clock preset), read a layer's world matrix (5 scenes picked their
  screen side from it), drive video textures (2), puppet animation layers and bones (3; the sway layers of
  3363252053 / 3414858021), particle systems, effect shader constants, the camera, and get the
  applyGeneralSettings / animationEvent / destroy events. `alphatocoverage` materials now draw as WE's cutouts.
- Found on the way: **every scene with a video texture cleared to black instead of its clear colour** (mpv left its
  own clear colour behind) — fixed.
- The 17 items still missing are render features (shadows, volumetric lights, bone physics, blend shapes, skinned
  models, script-built meshes) or unknowns; they're the "Future batches" at the end of that page.
- Six library scripts fail in Wallpaper Engine too (a script with two `update`s, a typo'd constant, …): listed on
  that page, left alone.
- **Health report rerun:** 86 clean / 10 degraded / 0 failed (was 75 / 21), script errors 38 → 11, no scene worse
  (the shader agent's patches, in the same pin, took dropped effects 57 → 0). By eye: 3243449890 now draws its
  triangle clock and the character, 3219908811 its cherry-blossom background and ring.
## 2026-11-04 night — F1: shadows and light cookies

- **3D scenes can cast shadows now** (fork patch 0071, pin `d338e97`). A light with "cast shadow" and the models with
  "cast shadow" are drawn into a shadow map, the same way WE does it. That covers spot lights, and point lights in all
  six directions. Spot lights can also project a light "cookie" texture (WE's default is a flashlight ring). Tube
  lights and directional lights now light models too; before, LWE ignored them.
- **None of your 96 scenes uses any of this.** The one scene with lights, 3477054430, has its shadows turned off. So
  I checked it on a test scene I made: cubes on a floor.
  - Before: no shadows, and the spot was a plain disc.
  - Now: each cube casts a shadow from both lights, and the spot shows the flashlight pattern. At first there were
    shadow stripes on the floor; I removed them by tuning the depth bias.
- **Every scene uses less video memory: about 10 MB less at 1080p, 76 MB less on the 6880×2880 scene.** LWE kept an
  unused full-screen buffer in every scene for the shadow map. Frame times are unchanged. A scene with shadows costs
  about 0.3 ms more per frame (on the test scene).
- Health report: 86 clean / 10 degraded / 0 failed, the same as before, and no scene changed. Shader sweep: 47 → 16
  failing compiles, none new. The shadow shaders WE ships now build; the few combinations that still fail are for
  animated (skinned) models, which LWE doesn't do yet (batch F4).
- Left: shadows from directional lights (WE splits them into "cascades"), WE's light clustering for scenes with many
  lights, the "ultra" soft-shadow mode, and a shadow-quality setting (it's WE's default, medium).

## 2026-11-04 night — the small WE-coverage gaps (F7–F9, fork patches 0072–0077)
- **Sprite orientation as WE does it** (0072): particle sprites set to `upright` / `fixed` (3174556087's rain
  splashes) now take WE's axes, read from its renderer code; a screen sprite in a tilted system faces the camera; a
  child system uses its own renderer instead of copying its parent's. Untilted systems draw exactly as before.
- **`alphawriting`, effect FBO `fit` / `width` / `height` / `uvs`, `command: swap`** (0073–0074): 3184155462's
  cursor-ripple buffers are now 512 px as WE sizes them; the stock fluid simulation's ping-pong works.
- **TEX<n>FORMAT per bound texture** (0075): DXT / RG88 normal maps unpack as in WE (lit layers, reflection).
- **resizeScreen** (0076): the worker now tells the core the output it shows the scene on.
  `engine.screenResolution` is that output (it was the scene's size), resizeScreen fires when it changes (not at
  start, as in WE), and `input.cursorScreenPosition` is in its pixels (it was 0..1 — 3509243656's mouse-follow read
  it as pixels and stuck at one edge).
- **Puppet animation events** (0077): an MDL animation's own events reach the layer's scripts (none in the
  library yet).
- Left: puppet **hit boxes** (where WE stores them isn't decoded; no library script reads them), text-layer writes
  re-laying text, `transformAttachmentToTexture`, three unknown .tex flags.

## 2026-11-04 night — F3/F4: blend shapes, bone alpha, skinned 3D models, createModelData (fork patches 0078–0081)
- **Blend shapes on puppets** (0079): WE's MDL morph targets (MDMP) and their animation weight tracks are read and
  applied, and scripts get `getBlendShapeIndex` / `get/setBlendShapeWeight`. Only 3490034653 has one: 人物1's blink
  target moves 25 eyelid points by a few pixels (under a pixel at the smoke's frames, so no visible change there).
  Bone alpha tracks work too (none in the library).
- **Skinned / morphed 3D models** (0080): a model with a skeleton is now posed by its animation layers and skinned on
  the GPU as WE does (generic4's SKINNING / MORPHING); the stock shadow casters build with those combos (0078: the
  shader sweep's 10 caster failures are gone). No library model has a skeleton, so nothing you have changes.
- **createModelData** (0081): scripts can build their own meshes and show them as model layers (also in 2D
  scenes). No library script does yet. Model layers are now script layers (getLayer returns them).
- Not done (decoded as far as the data, the solver not read): **IK** (one bone in 3042492564's arm) and **bone
  physics** (no library bone has it switched on), root motion, `applyBonePhysicsImpulse` (still a no-op).

## 2026-11-04 night — perspective layers and camera paths (F5), the stock particle operators (F6), fork patches 0082–0085
- **Perspective particles are now the size and depth WE draws them** (0082): 35 of your 2D scenes have particle
  systems marked "perspective" (snow, rain, dust). WE draws those through a perspective camera set by the scene's
  `perspectiveoverridefov`, placed so depth 0 lands exactly where the flat view puts it. LWE used the wrong camera
  (16 % too big at depth 0, and depth barely changed the size). Layers marked `perspective` (4 scenes) now tilt and
  move in depth as in WE; yours sit flat at depth 0, so they look the same.
- **Camera paths and camerafade** (0083): scenes can fly the camera along keyframed paths and fade between them.
  None of your scenes has a path (the 11 path files are all empty), so nothing changes. 3D scenes with
  transparent sorting now use WE's order (an object's `sortorder`, then depth).
- **The 20 particle operators only WE's own presets use** (0084–0085): flocking (boids), collisions with planes,
  spheres, quads and the screen edges, speed caps, value remapping, colour lists, HSV colours, control-point
  constraints, inheriting from a parent particle. None of your scenes uses them; WE's own element preview scenes
  now do what their names say (old core: plain white particles ignoring the operator). Some behaviour is read from
  WE's code exactly, some is inferred (marked in the audit).
- Smoke of all 96 scenes: none newly blank or failed. Health report 86 clean / 10 degraded / 0 failed, every scene
  as before; shader sweep 16 failing, none new.
- Left: the `layerimage` emitter, `collisionmodel`, the inferred parts of F6, text `depthtest` (no effect in 2D),
  `customsortorder`, the 3D camera's zoom and parallax.

## 2026-11-05 — WE coverage F2: shape objects, volumetric lights, puppet IK (fork 0086–0090, pin `127d63b`)
- **The "VolumeLight" in 3319542538 was a shape object** (WE's light-shafts quad), not a light. It now draws: pink
  light rays rising from the horizon right of the tree, added onto the scene as WE does. The health report no longer
  lists it as unsupported.
- **Volumetric lights** (`castvolumetrics` on point and spot lights): visible light cones / glow spheres in 3D
  scenes, with WE's own volumetrics shaders. None of your scenes turns it on (3477054430's spots have it off), so
  nothing of yours changes; checked on a synthetic scene. Not done: shadows and cookies inside the glow, fog,
  directional lights.
- **Puppet IK**: 3042492564's arm now follows its animated hand target (it stayed still). How WE solves IK
  wasn't found in its code; ours is a standard two-bone solver (marked inferred).
- **Not done: bone physics** (springy hair etc., `applyBonePhysicsImpulse`, gravity/wind): none of your puppets
  enables it, and WE's simulation code is a large unread rigid-body layer.
- Health report 86 clean / 10 degraded / 0 failed (3319542538 lost its VolumeLight error, nothing else moved);
  shader sweep 6 failing, none new; player tests 740 passed.

## 2026-11-05 — the scene-compatibility leftovers (fork 0091–0097, pin `be51bf7`)
- **Audio-reactive scenes see stereo now, and react far more.** The worker used to hand LWE a mono, 8-bit snapshot of
  the system audio each frame (Left = Right); it now passes every captured frame in order, in stereo. With a test tone
  37 of your 41 audio scenes react (22 before). 2290002190's audio-driven particles needed a second fix (scripts on a
  particle system's override values never ran; 11 scenes use those). 3445973124's pulse still doesn't move, unexplained.
- **Scene sound above full scale now clips like WE** (WE's audio library hard-clips its output at 0 dBFS; found in its
  DLL): a sound slider above 1 (2375914945's `musicvolume` 2) clips at the scene's output instead of reaching the bus
  above 0 dBFS. Your volume and the loudness normalization come first, so turning a scene down keeps its peaks whole.
- **Text is shaped like WE's (HarfBuzz)**: kerning pairs and ligatures, and WE's own list of fallback fonts for
  characters a font lacks (Arial → emoji → Arial Unicode → Segoe UI → WE's Twemoji → symbols → Chinese → Korean, each
  mapped to what your system has). 22 of 66 texts now match the size the editor saved to the pixel (4 before).
- **"World space" particle systems** keep their particles where they were emitted when the system moves:
  3104056709's cursor trail now trails. **Linked animations** (`parent` timelines, 5 scenes) run on one clock:
  3163060610's rounded panel waits for its script instead of animating at load.
- Health report **89 clean / 7 degraded** (was 86 / 10): the 25 "missing assets" were slots WE leaves to the material
  (an app-dock icon nobody picked, an empty default) and the `Text` warnings were link labels. The 7 left are script
  bugs in the scenes themselves — I checked each throws in WE too.
- Smoke of all 96 scenes: none newly blank. Shader sweep: the same 6 failing, none new. Player tests 743 passed.
- Left / for you: a WE capture of 3414858021's "WEDNESDAY" (reaches the screen edge here) and of 3445973124 with music.

## 2026-11-05 — the decode leftovers (fork 0098–0100, pin `4e2f3c8`)
- **HDR scenes follow WE's real switch.** WE renders a scene HDR only when its file turns on both `hdr` and
  `bloom` (and WE's post-processing is Ultra); found in its project loader. 2511663284 (HDR on, bloom off) is
  drawn the ordinary way now, as WE draws it. The other four HDR scenes are unchanged.
- **PBR masks work.** Masks painted in WE's editor mark which channels they carry (metallic / roughness /
  reflection / emissive); WE switches the matching shader options on from those marks, LWE ignored them.
  3477054430's mask now gives roughness + glow, 3509243656's models their glow.
- **3516106265's frame builder** gets the layer's transform it reads its scale from (was all zeros, so the frame
  collapsed).
- Checked against WE's code and left as they were (LWE's guesses were right): the particle force step's frame
  time, when a particle sub-system counts as finished, the additive puppet layer's scale, SceneScript angles in
  degrees. Read but not changed: the puppet attachment (WE applies the whole bone matrix; LWE its offset + turn)
  and the rope curve (WE's control points sit within 10 % of LWE's). Not found: what WE's g_TexelSize divides by.
- Health report 89 clean / 7 degraded / 0 failed (no scene worse, none newly blank); shader sweep the same 6
  failing, none new; player tests 743 passed.

## 2026-11-05 — the last decode leftovers (fork 0101, pin `5de0663`)
- **Puppet attachments apply WE's whole matrix.** WE pins a child (3463520581's hair, cloth and accessories) with the
  bone's full matrix times the attachment's; LWE used only its position and turn. Read from WE's code which matrices
  those are (the posed bones, as LWE assumed) and ported the rest (a bone's scale now reaches the child). Nothing in
  your library looks different: all its puppet bones keep unit scale, and the attached layers sit exactly where they
  did.
- Read, not changed: the rope curve's control points (the neighbouring particles, as LWE has; only a 0.15 vs 1/6
  tangent factor differs, under a pixel for a segment up to ~150 px), and the SceneScript degrees flag (it also marks
  shader angles WE shows scripts in degrees; no scene of yours scripts one). Still not found: what WE's g_TexelSize
  divides by.
- Health report 89 clean / 7 degraded / 0 failed (no scene changed); shader sweep the same 6 failing, none new;
  player tests 743 passed.

## 2026-11-05 — rope curves bend as WE's (fork 0102, pin `25d6088`)
- **A rope's curve now uses WE's own tangent factor** (0.15 where LWE's Catmull-Rom had 1/6): a bent rope bows about
  10 % less, as in WE. Under a pixel for ordinary rope segments, so nothing in your 20 rope scenes looks different in
  the smoke frames beyond run-to-run particle noise. New test rig: a rope of particles at fixed spots (one emitter per
  particle), the test fails on the old pin (7.0 px bow) and passes now (4.0 px; WE's maths says 4.2).
- Gates: the 20 rope scenes' health 15 clean / 5 degraded / 0 failed on both pins (no class or loss changed); shader
  sweep the same 6 failing checks, none new; player tests 743 passed.

## 2026-11-05 morning (scene preview compare, finished)
- Pushed `lp-player` through the scene-preview work: LWE pin `77b9df7` (fork 0103 culling puppets draw — 3490034653's
  and 3363252053's characters were invisible; 0104 `thisLayer` / `thisObject` are the running script — 3163060610's
  clocks stuck on "Loading..."). Live player rebuilt and restarted on it.
- New report `docs/player/reports/scene-preview.md`: every scene scored against its author's preview. Everything above
  the clean band was looked at; no further render bug — the rest are previews with badges / frames / signatures,
  other animation moments, audio or media-driven parts, or user properties that default off.
- One question only you can settle: **3516174947** at its default "Lens size" 0.75 shows black borders in ours (the
  decoded zoom formula); its preview has none. A WE screenshot of it at the default settles which is right.
- `mpv_source_teardown_never_skips_bus_cycles` fails today on the old commit as well (a flake of this machine's
  state, in TODO); nothing in this work touches mpv.

## 2026-11-05 — the failing bus-cycle test was the test's own PipeWire
- **`mpv_source_teardown_never_skips_bus_cycles` is fixed; the player was never at fault.** The short silent gaps
  came from the private PipeWire server the tests start, not from Liascape. Its graph timer ran at normal priority
  (no real-time module in the test config) while your system config asks every stream for a 64-sample quantum
  (1.3 ms). Whenever that thread woke 1.3 ms late, the whole test graph skipped one cycle. PipeWire's own profiler
  showed it on every gap: the server's driver skipped a period, while the player's streams were on time.
- Not a regression: the commit that added the test (b94a111) fails just as often (3 of 8) when alternated with
  today's (0 of 8). It slipped through because it fails only about 1 run in 5 when the machine is quiet.
- Fix: the test server now runs real-time, like your real PipeWire and like the on-machine harness (`scenes.sh`)
  already did. Before → after: quiet 5 failed of 26 runs → 0 of 20 (no gap at all); with the CPU saturated
  38–90 gaps per run, 4 of 4 failed → 0–1 gaps, 1 of 4 failed. Your own audio setup is untouched.
- Full player suite with the fix: 743 passed, 1 failed, 3 ignored. The one failure,
  `scene::gpu_stall_that_starves_the_worker_is_not_a_hang`, doesn't use PipeWire and passed 3 of 3 alone (a timing
  flake under the full suite's load).

## 2026-11-06 — 3184155462's mouse water
- **Why it was much stronger than on Windows:** that wallpaper's water (WE's "cursor ripple") adds a push and takes a
  little away *every frame*, so how strong it looks depends on the frame rate — WE's own water is strong at 30 fps and
  faint at 120 (the new reference captures show it). Your Windows WE runs at 240 fps, so you see it faint there. Ours
  ran it once per frame actually drawn: this scene is heavy at 4K, so when the player lowered its frame rate (or a
  frame came late) every frame pushed several frames' worth. Also, when the mouse came onto the wallpaper from the
  other screen or from behind a window, ours drew one big stroke along the jump (WE follows the mouse everywhere, so it
  never jumps). The collision mask is right: in both, the water only moves at the sides, not over the girl.
- **Fixed** (LWE pin `1273652`, fork patches 0105–0106): the water now steps at the scene's frame rate (your screen's
  refresh, or `out:<c>.scene_fps` if you set one), whatever rate frames really arrive at — so it behaves like WE at
  that fps, fps dependence included (your call: a faithful port). A mouse arriving on the wallpaper no longer strokes.
  Before / after pictures: `/tmp/claude-1000/ripple/3184155462-ripple-before-after.png`.
- To get WE's look at another fps (e.g. WE's "ultra" 30 fps, where the water is strong), set the output's scene fps to
  it. Not decoded yet: whether WE also caps its fps at the monitor's refresh (your main screen is 144 Hz, WE set to 240).

## 2026-11-06 — WE's frame rate and the mouse behind windows
- **How WE limits its frame rate (read from its program):** after each frame it sleeps so that your "FPS" setting's
  number of frames fill each second, and it shows frames without waiting for the screen's refresh. So WE really runs
  at your setting even above the monitor's refresh: at 240 on your 144 Hz screen it draws 240 a second and Windows
  shows the newest 144 of them. (The number the earlier notes called "the fps timer" is how often WE reads system audio
  for visualisers — twice per frame — not the frame limiter.) WE's default for a fresh install is **15 fps**.
- **Ours now does the same:** a scene runs at the fps you set for that monitor, even above its refresh (before, it was
  capped at the refresh). The default for a monitor you haven't set is now 15 (WE's), in the player, the backend and
  the Settings page (adding or detecting a monitor fills in 15, not the refresh). **Nothing changes for you today:**
  your monitors are set to 144 and 240 explicitly.
- **The mouse behind windows:** WE follows the mouse over the whole desktop — over windows and the other screen too.
  Ours only saw it over the bare wallpaper, so a mouse-following scene froze while the cursor was over a window. Now,
  on Hyprland, the player asks Hyprland where the cursor is, as often as the scene draws (at 240 a second: about 1.4 % of
  one CPU core in the player and 0.6 % in Hyprland), and only while a scene is playing. Scenes follow the cursor everywhere, like
  WE; clicks still count only on the bare wallpaper (as before). If Hyprland can't be asked, it falls back to the old
  behaviour by itself.
- Pushed and restarted the player (it came back with your scene; at the moment it is held paused because a window
  covers the screen, so it isn't asking Hyprland anything).

## 2026-11-06 — the flake now has mpvpaper 1.9 (nixpkgs bumped 4 months)
- **mpvpaper 1.9 is in** (the libmpv fence-leak fix, PR #132). Only the flake's `nixpkgs` moved (2026-07-11 →
  2026-11-03, `1d06008`); nothing on your system changed. A side-by-side on a private headless screen (same synthetic
  1080p60 loop, 4 min each): **1.8 grew ~19 MB a minute without stopping, 1.9 stayed flat.** Still to do: watch it
  on your real desktop — if it stays flat, the legacy "restart mpvpaper every N s" default (600 s) can go to 0.
- What else moved with it (the full list is in the commit message): Rust 1.96 → 1.99, gcc 15 → 16, glibc 2.42 → 2.44,
  ffmpeg 8.1 → 9.0, harfbuzz 13 → 14, .NET SDK 10.0.301 → 10.0.403, Electron 42.5 → 42.11, cmake 4.1 → 4.4. Every
  flake package, the dev shell, LWE's core (built + checked + its 122 host tests), the player suite, the adapter
  integration test, the scene health report and the shader sweep came out the same as before (details below).
- **Electron 42 is end-of-life**: nixpkgs now refuses it as "insecure", so the flake lets Electron 42 through by name
  and nothing else. Moving to a newer Electron is your call (the app, the AppImage and the flake move together) — in TODO.
- Results: player suite 742 passed / 3 failed / 3 ignored, and the 3 (PipeWire bus-cycle timing tests) passed 3 of 3
  each when run alone. Adapter integration test: 404 / 0. The first run had 11 failures while Wallpaper Engine was
  running for the reference captures at the same time (load ~12). One check really was stale: it still expected the
  old 30 fps scene default instead of the new 15, fixed. Scene health 89 / 7 / 0, the same 7 degraded scenes with the
  same losses. Two scenes timed out during the load and were clean when run alone. Shader sweep: the known 6 failures
  in 4 shaders.
- **Other agents' next builds pick up the new toolchain**: their first `cargo build` in each worktree recompiles
  everything (new rustc), and the first `nix develop` downloads the new shell (~1 GB). The adapter test now runs on
  `.NET 10.0.403` (`/nix/store/h78hbfhakw6sbd82xpjx1qyd0pbmhdjl-dotnet-sdk-wrapped-10.0.403/bin/dotnet`; battery.sh's
  fallback updated).

## 2026-11-06 — the "HDR at Ultra" look was the references, not ours
- **3019192537 and 3395587987 look on Windows the way ours does, and that is WE at Ultra.** The dark, oversaturated
  reference frames came from DXVK, not from a WE feature we were missing. At Ultra, WE draws a scene whose
  settings have both `bloom` and `hdr` into a 16-bit float swap chain, written in linear light. Windows converts
  that back to normal sRGB for your SDR monitors, so it looks as composed. Under Proton, DXVK has no HDR colour
  space on the virtual screen, so it showed the linear values raw: too dark. Found in WE's own code (the swap-chain
  format follows the Ultra flag) and in DXVK's source.
- wallpiper's frames agreed with the dark ones only because it reads the same DXVK output. Re-encoded the way
  Windows does it, both WE sources match ours to 2–4 / 255.
- `postprocessing=enabled` matches ours with LWE's `WPENGINE_HDR=0` (0.5–0.8 / 255). So you don't need to check
  which Windows profile you run: neither one looks dark. Ours renders as WE at Ultra, and has no quality setting
  for WE's post-processing tiers. A player setting for that is in TODO, not built.
- **The capture is fixed.** For the 4 affected scenes (2542468435, 3019192537, 3395587987, 3509243656),
  `we-ref-capture.sh` re-encodes the frames as Windows shows them, keeps the raw ones, and marks them in the report.
  All 4 were recaptured. No other reference was affected: every other scene uses an 8-bit swap chain.
- **One real bug of ours, fixed:** at Ultra, WE multiplies a layer's colour by its `brightness` in these HDR scenes.
  2542468435's layer is set 15 % brighter and ours never showed it. Scores (0 = identical): 3019192537
  0.60 → 0.12, 3395587987 0.48 → 0.08, 2542468435 0.48 → 0.02.
- 3490034653 is something else: a warm glow from its light-shaft particles that WE doesn't draw. They were drawn
  upside down, the same bug as 3354740764's extra light shafts. Another agent's fix for that one removes the glow
  here too (tried locally). What is left are small position differences: the camera sway is at a different
  moment in each run.
- Your Windows `config.json` says MSAA **x2**; the references use x8. That changes edges only, not colour, so they
  weren't recaptured.
- Checks: LWE host tests 123 / 123 (1 new), scene health 89 / 7 / 0 (as before), shader sweep the known 6 failures.
  Player suite 738 passed / 14 failed with other agents loading the machine (load 20–50). Run again alone, 13 passed.
  `mpv_source_teardown_never_skips_bus_cycles` still failed 3 times at load 20–53. That test's own note says a
  loaded debug run can lose a bus cycle, and nothing it runs changed here (no player code, only the scene core).
  Re-run it on a quiet machine.

## 2026-11-06 — WE-reference fixes: 3354740764's dog and light shafts (3490034653's glow too); two "time" rows that are the capture's
- **The dog's black box is gone** (fork `7797317, patch 0110`). The dog image uses WE's `alphatocoverage` blending and has effects
  (clouds, blur, shake). With effects, the layer's blending moves to its last pass, and ours drew that pass without
  blending, so the dog's transparent surroundings came out as an opaque dark square. WE (both references) cuts it
  out. Only this scene uses `alphatocoverage`.
- **Particle sprites were upside down in every scene** (fork `317bb73, patch 0111`). Round sprites hid it; light shafts didn't:
  in 3354740764, 1726902114 and 2561227934 the shafts rose from the grass at a slant, where WE has them hanging from
  the top of the sky. Now they stand as in WE. If some other particle effect in your scenes looks different (flipped)
  from before, this is why — and it should now match Windows.
- **Not bugs of ours** (proved with extra WE captures, nothing to fix in the renderer):
  - 3354740764 "black at 0.5 s": the scene opens with a black fade layer (gone at 1.6 s) that WE draws too. The
    reference's t = 0 is taken at WE's first frame with a picture, already inside that fade, so WE's frames are about
    1 s ahead of ours. wallpiper's 0.5 s frame is still dimmed by it.
  - 2672425887 "the demon fades in 3 s later in ours": it fades in at 2.07–2.6 s in both. WE's clock is 0.2–1.1 s
    ahead of the reference's t = 0, a different amount every run (four captures), and ours at 2 s is 0.07 s before
    the fade starts — the 0.5 / 2 / 5 s samples made it look like 3 s.
  - The reference time base itself is in TODO (scenes with intros need a per-run clock estimate or some slack).
- Scores (WE compare): 3354740764 0.545 → 0.523 (2 s: 0.342 → 0.294; the 0.5 s frame is the time base, the rest mostly Ultra post-processing), 2561227934 0.256 → 0.218, 1726902114 0.092 → 0.080, 3490034653 0.424 → 0.414; 2672425887 unchanged.
- The regenerated report (whole corpus, fork head 317bb73 with the other agents' HDR / fog / colour-blend fixes) has
  2134765860 at 0.46: it is a day/night scene on the wall clock, captured by WE at 16:56 and rendered by ours after
  18:00 (night). Same picture at the same hour; noted in the report.

## 2026-11-06 — scene normalization is set once per play
- **What was moving the volume:** the backend's normalization, not anything in the scene worker (it has no automatic
  gain or limiter). Every time a scene's loudness report came in (after its first ~60 s of sound, then every further
  minute) and the measured value had moved by half a unit or more, the playing scene's volume was ramped to the new
  value. Your log since this morning has 209 of those; Emilia (2951169110) and Summer feeling (1884904087) each moved
  three times in one play. Measured on a private player: Emilia's first play moved at 52 s, 96 s and 170 s; its second
  play (already measured) still moved once, at 115 s.
- **Now, as you asked:** a scene plays at one level for the whole play. A scene that was never measured plays at its
  estimate (unity if it has none) and changes once, when its first 60 s of sound are measured (an estimated scene
  counts the estimate as 10 s, so that's after ~50 s of sound). After that, the measuring only refines the stored
  value, which the next play starts with. A scene that already has a measurement starts at it and never changes.
  Your own changes (normalization on/off, the target, a scene property that changes its sound) still apply at once.
  Same private test after the change: Emilia's first play changed once (at 54 s) and its second play not at all,
  while the stored value moved four times.
- **Possibly also what you heard:** auto-mute flips your wallpaper off and on in bursts when another app's sound has
  short gaps (12:14:30–12:14:46 today: 6 mutes in 16 s with Spotify and a KDE notification stream; your "unmute after"
  is 500 ms). A longer unmute delay would stop that; not changed.
- Side note: the player caps the total gain at +12 dB, so a very quiet scene is boosted at most 12 dB (Emilia wants 13).
- Checks: backend self-test PASS (new: the "set once" rules and the pin table); player suite 749 passed / 3 failed /
  3 ignored, the 3 (bus-timing tests under load ~100) passed alone; adapter integration test 406 / 1 — the 1 an
  auto-mute `/stop` timing check, the auto-mute section alone then 63 / 1 (a different timing check) and 64 / 0. Its
  scene-loudness section's new checks: a louder third play moves the stored value but keeps its own level through
  further reports and a full settings pass; the fourth play opens at the new level.

## 2026-11-06 — the 3D scenes against real WE
- **3276522107 (night metro): the lighting was never wrong.** The lit version of the train flashes on and off every
  2 s (the passing street lights), and the three reference frames happened to catch WE between flashes and ours in
  one. Four separate WE runs flash exactly like ours, same brightness. WE's own clock is already 0.25–0.9 s along when
  its first frame shows, a different amount each run, so the flashes land at other moments. Nothing to fix there.
- **3509243656 (space HUD): nothing wrong in ours.** Its "darker in WE" was the capture of WE's HDR output (fixed in
  the references by the HDR work). Against the corrected reference the brightness is the same; its intro only looks
  "late" in ours for the same clock reason as above (~0.75 s).
- **3477054430 (kitty on a rooftop): fixed, the moon now sits in the scene's fog like in WE.** It was too bright: WE
  fogs 3D image layers, ours only fogged models. Found with it: a layer with a colour blend mode took its colour and
  transparency twice. 2371103399's two see-through layers were too faint, and are now as in WE (its score 0.071 →
  0.013). Left: the kitty's head follows the mouse differently in a 3D scene (WE casts the mouse into the 3D world;
  in TODO).
- Checks (fork `867a5e7` + `5a42e7e`, patches 0108–0109; already in the pin `317bb73` the dog fix landed): LWE host
  tests 125 / 125 (2 new, both fail before the fix). Scene health 89 / 7 / 0 and the shader sweep's known 6 failures,
  both as before. Player suite: 734 passed and 18 failed at load 40–74 (supervisor, bus-cycle and transport timing),
  and all 18 passed when run alone. No player code changed.

## 2026-11-06 — WE references: each frame's real scene time; the "time" rows are gone
- **WE's own clock is in every reference now.** WE's scene clock was 0.1–1.1 s ahead of the capture's "t = 0", a
  different amount every run, so intros, fades and animation phases looked like bugs. The capture now opens a private
  copy of each scene (never the Workshop folder) with one extra layer: a thin strip along the bottom edge that shows
  WE's own scene time in binary. Each frame's real time is read from it, and ours is rendered at exactly that time.
  A test scene proved the strip, a script's `engine.runtime` and the frame agree to the ms. The strip is cut off
  both pictures in the compare. (The "dark bar along the bottom" the 3D agent saw in the new captures is that strip.
  Use the compare from this commit on, which crops it.)
- Also in the compare: ours runs at the capture's wall time (clocks, dates, day/night), and with the Windows
  install's fonts (the faces WE drew with; only a private fontconfig file of the run points at them).
- **Whole library recaptured and re-ranked: mean score 0.119 → 0.072.** 3509243656 0.26 → 0.05, 2783122117 0.56 → 0.01, 3593587273 0.50 →
  0.02, 2134765860 0.46 → 0.005, 2672425887 0.43 → 0.14, 3419466417 0.34 → 0.08, 3354740764 0.52 → 0.33.
- **3354740764** (your Windows XP scene): the notepad wraps differently only because this system has no Consolas
  (its stand-in is narrower); with Consolas ours wraps exactly like WE. The colour difference is two layers, found by
  removing layers in both WE and ours: the clouds layer (turned 180°) darkens the bottom of the grass in ours, where
  WE's barely shows; and ours' light shafts in the top right (random in WE). The background with all its effects
  matches WE. The clouds layer is in TODO, not fixed yet.
- **3490034653**: with the times aligned, the layers sit within about 1 px of WE's. What's left is a light-shaft haze
  (random in WE), petals and the clock's minute.
- **Your call (TODO):** the 19 scenes that name Windows fonts (Consolas, Comic Sans, Arial …) draw with Linux
  stand-ins in your player, so text can wrap differently. A "Windows fonts folder" setting (found on your mounted
  Windows drive) would fix that. Not built.
- No renderer change in this round, so no LWE pin bump, player rebuild or restart.

## 2026-11-06 night — a broken audio filter no longer silences a video; the scene "warble" not reproduced
- **Your silent wallpaper (21:35) can't happen again, whatever the filter.** The cause: with the normalization target
  at 0, the loudness filter got a value ffmpeg refuses; mpv accepted the setting (it knows the filter) and only
  failed when building it — and then played the video with **no audio at all**. The target is already kept in range
  since this evening; now the player also survives any filter mpv can't build: it drops it, plays the sound
  un-normalized, logs a warning (the player's `source.rejected`, and a line in the backend's log "player refused af
  on …"), and the `sources` probe shows `af_refused` with ffmpeg's own reason. New player tests (they fail without the
  fix with exactly your symptom: no audio output, track deselected) + adapter IT checks with a target of 0 written
  straight into a private settings.json.
- **"Loud quiet loud quiet" when a scene fades out: not found on our side yet.** 39 transitions recorded on a
  private PipeWire at your quantum (64), real-time, two outputs at 144/240 Hz, with your own pairs from today's log
  (Lofi Girl → MIKU_MK2, the skeletons → 壁纸循环, Chainsaw Man → EP05, Street Japan → Miku Miku, 流萤 → Lofi Girl,
  Evernight → Madara) plus synthetic ones, many effects, all three methods, A at 0.8×/1×/1.25×, and the player
  frozen mid-fade. Each one recorded the scene's own stream: it is the scene's sound file × the fade to within
  ~0.4 dB (p95). The dips I first took for a warble (Chainsaw Man) are in the song itself. So the scene's audio
  path, the time stretch, the gain ramps and a stalled player are ruled out. Not covered: your EasyEffects chain on
  the HDB 630, and multi-second player stalls (your log has 13–34 s ones today). **Ask:** next time, note the time and
  whether it's the old wallpaper's sound or the new one's — most of today's scenes that faded out had no sound at
  all, so it may be the incoming video. The recording tools are in `src/player/tests/onmachine/transition_audio/`.

## 2026-11-07 — a click while the player stalls is no longer lost
- **The adapter-IT failure "/apply b right after a library item never switched" was the test's own typo**, not the
  player: one line sent `{path:/tmp/…/b.mp4}` (unquoted JSON); the backend refused it (HTTP 400) and the test hid the
  error. Reproduced exactly; the test now fails loudly on any request body that isn't JSON.
- **Chasing it found a real bug you could hit:** a wallpaper you picked while the player was stalled (it froze for
  13–34 s a few times in your log yesterday) was silently dropped — when the player came back, the screen kept the old
  wallpaper while the app showed the new one, until you clicked again. Now the backend remembers the pick, keeps
  asking the player every half second, and puts it on screen (a cut) as soon as the player answers; clicking twice
  during the stall shows the newer one, once. A Stop, or picking a single wallpaper over a running playlist, during a
  stall is caught up the same way. New IT check: two clicks while the player is frozen 4.5 s → the second one shows
  (fails on the old backend: the old wallpaper stayed).
- Two quick clicks with the player responsive were always fine (both queued in order, the newer wins).
- Side fix: the backend self-test had quietly stopped before its main part since the Settings rename (it expected
  the player's "can't pause behind windows" warning to use the new row name) — the player's warning now says "Pause
  behind windows", and the full self-test passes again.
- Adapter IT, this branch vs unchanged lp-player, after the reboot (machine quiet): **413 pass / 1 fail** vs **411 / 1**
  (the branch has the 2 new checks). The one failure is the same in both — the playlist-restart section's precondition
  "the new backend answered after p1's first loop ended" (a timing precondition, pre-existing). A first branch run had
  4 more (20 × /random non-200, two scene-loudness timing checks); none came back on the rerun, so load flakes — the
  /random check now prints the HTTP codes it got if it fails again.
